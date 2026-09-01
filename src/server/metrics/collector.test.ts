import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type os from "node:os";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { openDb, runMigrations } from "../db";
import { createMockDockerAdapter } from "../adapters/mock";
import { createModelRepo } from "../repo/models";
import { createRuntimeService } from "../runtime";
import { createMetricsCollector } from "./collector";
import { METRIC_IDS, type Sample } from "./ids";
import type { FetchLike } from "./health";
import type { ChildProcessLike, ExecFileLike, SpawnLike } from "./nvidiaSmi";
import type { ModelConfig } from "../../core/schemas";

/**
 * 指标调度器测试（M3 Task 2，TDD）
 *
 * 搭建对齐 runtime.test.ts：:memory: 库 + mock 适配器 + 临时 models 根；
 * fake timers 推进 5s/10s 断言心跳节奏与样本流。
 * fetch / execFile 注入：health 走"连接拒绝"降级、nvidia-smi 走 ENOENT 降级，
 * 调度器本身不做真实网络 / 子进程 IO。
 */

const T0 = new Date("2026-01-01T00:00:00Z").getTime();

/** ENOENT 风格错误（nvidia-smi 不存在） */
function enoent(): Error {
  const err = new Error("spawn nvidia-smi ENOENT") as Error & { code: string };
  err.code = "ENOENT";
  return err;
}

/** 总是失败的 execFile（nvidia 不可用注入） */
const noNvidia: ExecFileLike = (_command, _args, callback) => {
  callback(enoent(), "");
};

/** 双卡 CSV 输出（nvidia-smi 探测成功注入，见 T3 任务书样本） */
const twoGpus: ExecFileLike = (_command, _args, callback) => {
  callback(null, "0, 8192, 24576, 45, 67, 320.5\n1, 6144, 24576, 78, 72, 355.0\n");
};

/** 总是连接拒绝的 fetch（health 降级注入） */
const refusedFetch: FetchLike = () => Promise.reject(new TypeError("fetch failed"));

interface World {
  db: Database.Database;
  adapter: ReturnType<typeof createMockDockerAdapter>;
  runtime: ReturnType<typeof createRuntimeService>;
  root: string;
}

let world: World;

function addModel(partial: Partial<ModelConfig> & { name: string }): void {
  createModelRepo(world.db).createModel({
    display_name: partial.name,
    namespace: "main",
    gguf_file: "main/a.gguf",
    overrides: {},
    ...partial,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(T0));
  const db = openDb(":memory:");
  runMigrations(db);
  const root = mkdtempSync(path.join(tmpdir(), "llamapad-metrics-"));
  const adapter = createMockDockerAdapter();
  world = { db, adapter, root, runtime: createRuntimeService(db, adapter, root, root) };
  const gguf = path.join(root, "main/a.gguf");
  mkdirSync(path.dirname(gguf), { recursive: true });
  writeFileSync(gguf, "x");
});

afterEach(() => {
  vi.useRealTimers();
  world.db.close();
  rmSync(world.root, { recursive: true, force: true });
});

describe("createMetricsCollector：5s 心跳与样本流", () => {
  it("运行中模型：每 tick 产出 container 三样本（值来自 mock stats，确定性），infer/gpu 降级无样本", async () => {
    addModel({ name: "a" });
    await world.runtime.startModel("a");

    const samples: Sample[] = [];
    const collector = createMetricsCollector({
      adapter: world.adapter,
      db: world.db,
      onSample: (sample) => samples.push(sample),
      fetch: refusedFetch,
      execFile: noNvidia,
    });

    collector.start();
    expect(samples).toEqual([]); // start 不立即 tick，等第一个 interval

    await vi.advanceTimersByTimeAsync(5_000);

    // nvidia probe（启动一次）确认为不可用
    expect(collector.isNvidiaAvailable()).toBe(false);

    const containerSamples = samples.filter((s) => s.metric.startsWith("container."));
    expect(samples).toHaveLength(3); // 恰好 3 个，无 infer.*/gpu.* 样本
    expect(containerSamples.map((s) => s.metric)).toEqual([
      METRIC_IDS.containerCpuPercent,
      METRIC_IDS.containerMemBytes,
      METRIC_IDS.containerMemPercent,
    ]);
    // mock stats 在 elapsed=5000 时的确定性伪值：cpu≈50、mem 276MiB、mem% 276/8192×100
    expect(containerSamples[0].value).toBeCloseTo(50, 6);
    expect(containerSamples[1].value).toBe(276 * 1024 * 1024);
    expect(containerSamples[2].value).toBeCloseTo(3.369140625, 9);
    expect(containerSamples.every((s) => s.ts === T0 + 5_000)).toBe(true);
  });

  it("推进 10s → 两个 tick 共 6 样本；stop 后不再 tick；stop 幂等；start 幂等（重复 start 不叠加 interval）", async () => {
    addModel({ name: "a" });
    await world.runtime.startModel("a");

    const samples: Sample[] = [];
    const collector = createMetricsCollector({
      adapter: world.adapter,
      db: world.db,
      onSample: (sample) => samples.push(sample),
      fetch: refusedFetch,
      execFile: noNvidia,
    });

    collector.start();
    collector.start(); // 幂等
    await vi.advanceTimersByTimeAsync(10_000);
    expect(samples).toHaveLength(6); // 2 tick × 3 样本

    collector.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(samples).toHaveLength(6); // stop 后无 tick
    collector.stop(); // 幂等不抛
    await vi.advanceTimersByTimeAsync(5_000);
    expect(samples).toHaveLength(6);
  });

  it("无运行模型 → tick 无样本（不产生任何 metric）", async () => {
    addModel({ name: "a" }); // 配置了但未启动
    const samples: Sample[] = [];
    const collector = createMetricsCollector({
      adapter: world.adapter,
      db: world.db,
      onSample: (sample) => samples.push(sample),
      fetch: refusedFetch,
      execFile: noNvidia,
    });

    collector.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(samples).toEqual([]);
  });

  it("infer 样本经调度器接线：hostPort 取 mergeConfig（模型 overrides 覆盖生效），请求打到该端口", async () => {
    addModel({ name: "a", overrides: { docker: { host_port: 18777 } } });
    await world.runtime.startModel("a");

    const urls: string[] = [];
    let decoded = 100; // 处理中 slot 的 next_token.n_decoded：跨轮递增算生成速率
    const fetchMock: FetchLike = (url) => {
      urls.push(url);
      // 真机契约（M4）：/health 只回存活，slot 信息在 /slots
      if (url.endsWith("/health")) return Promise.resolve(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
      if (url.endsWith("/slots"))
        return Promise.resolve(
          new Response(
            JSON.stringify([
              { id: 0, is_processing: false },
              { id: 1, is_processing: true, id_task: 42, n_prompt_tokens: 334, next_token: [{ n_decoded: decoded }] },
            ]),
            { status: 200 },
          ),
        );
      return Promise.resolve(new Response("", { status: 200 }));
    };

    const samples: Sample[] = [];
    const collector = createMetricsCollector({
      adapter: world.adapter,
      db: world.db,
      onSample: (sample) => samples.push(sample),
      fetch: fetchMock,
      execFile: noNvidia,
    });

    collector.start();
    await vi.advanceTimersByTimeAsync(5_000); // 第一轮：health 样本 + 生成速率基线
    expect(urls.every((u) => u.startsWith("http://127.0.0.1:18777/"))).toBe(true);
    const slotsRunning = samples.filter((s) => s.metric === METRIC_IDS.inferSlotsRunning);
    expect(slotsRunning).toHaveLength(1);
    expect(slotsRunning[0].value).toBe(1); // 两个 slot 里一个 is_processing
    const kv = samples.filter((s) => s.metric === METRIC_IDS.inferKvCacheTokens);
    expect(kv[0].value).toBe(434); // 334 prompt + 100 decoded

    decoded = 250; // 同一 slot（同 id_task）继续生成：5s 内 150 token
    await vi.advanceTimersByTimeAsync(5_000); // 第二轮：150/5 = 30 tokens/s
    const tokens = samples.filter((s) => s.metric === METRIC_IDS.inferTokensPerSec);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].value).toBe(30);
  });

  it("调度器透传 nvidia 三态：start 前 probing", () => {
    const collector = createMetricsCollector({
      adapter: world.adapter, db: world.db, onSample: () => {}, execFile: noNvidia,
    });
    expect(collector.nvidiaStatus()).toBe("probing");
  });

  it("未采集时 nvidiaDevices()/lastCpuCount() 分别返回空数组与 null", () => {
    const collector = createMetricsCollector({
      adapter: world.adapter, db: world.db, onSample: () => {}, execFile: noNvidia,
    });
    expect(collector.nvidiaDevices()).toEqual([]);
    expect(collector.lastCpuCount()).toBeNull();
  });

  it("nvidiaDevices() 转发：双卡 CSV 采集后转发出长度为 2 的分卡明细", async () => {
    const collector = createMetricsCollector({
      adapter: world.adapter,
      db: world.db,
      onSample: () => {},
      fetch: refusedFetch,
      execFile: twoGpus,
    });

    collector.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(collector.nvidiaDevices()).toHaveLength(2);
  });

  it("lastCpuCount() 转发：运行中模型采集一帧后转发 mock stats 的 cpuCount", async () => {
    addModel({ name: "a" });
    await world.runtime.startModel("a");

    const collector = createMetricsCollector({
      adapter: world.adapter,
      db: world.db,
      onSample: () => {},
      fetch: refusedFetch,
      execFile: noNvidia,
    });

    collector.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(collector.lastCpuCount()).toBe(8); // mock adapter 的固定伪值
  });
});

/** 供 GPU 常驻流测试用的 fake 子进程：stdout 可写、kill 可断言、exit 可手动触发 */
function fakeGpuResidentProcess(): {
  proc: ChildProcessLike;
  stdout: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  emitExit: () => void;
} {
  const stdout = new PassThrough();
  const kill = vi.fn();
  const exitListeners: ((code: number | null) => void)[] = [];
  const proc: ChildProcessLike = {
    stdout,
    on(event, listener) {
      if (event === "exit") exitListeners.push(listener as (code: number | null) => void);
    },
    kill,
  };
  return { proc, stdout, kill, emitExit: () => exitListeners.forEach((l) => l(null)) };
}

describe("createMetricsCollector：秒级快照（秒级指标采集 代号 B）", () => {
  it("容器切换：换订阅时旧容器的秒级快照被清空，不残留到新容器名下", async () => {
    addModel({ name: "a" });
    addModel({ name: "b", overrides: { docker: { container_name: "llama-b" } } });
    await world.runtime.startModel("a");

    const collector = createMetricsCollector({
      adapter: world.adapter,
      db: world.db,
      onSample: () => {},
      fetch: refusedFetch,
      execFile: noNvidia,
    });
    collector.start();

    await vi.advanceTimersByTimeAsync(5_000); // tick1：建立对 a 容器的秒级订阅（刚订阅，尚无帧）
    expect(collector.latestFastSamples()).toEqual({});

    await vi.advanceTimersByTimeAsync(1_000); // a 的秒级流吐出第一帧
    expect(collector.latestFastSamples()[METRIC_IDS.containerCpuPercent]).toBeDefined();

    await world.runtime.startModel("b"); // 单模型约束：内部先停 a 再起 b（不同容器名）
    await vi.advanceTimersByTimeAsync(4_000); // tick2（t=10s）：探测到容器名变化，换订阅
    // 换订阅当下：旧帧已清空，新容器尚未吐出秒级帧——不应残留 a 的旧值
    expect(collector.latestFastSamples()).toEqual({});

    await vi.advanceTimersByTimeAsync(1_000); // b 的秒级流吐出第一帧
    expect(collector.latestFastSamples()[METRIC_IDS.containerCpuPercent]).toBeDefined();
  });

  it("dockerStats 优先用秒级帧：拿到过秒级帧后，后续 5s tick 不再触碰阻塞的 adapter.stats()", async () => {
    addModel({ name: "a" });
    await world.runtime.startModel("a");
    const statsSpy = vi.spyOn(world.adapter, "stats");

    const collector = createMetricsCollector({
      adapter: world.adapter,
      db: world.db,
      onSample: () => {},
      fetch: refusedFetch,
      execFile: noNvidia,
    });
    collector.start();

    await vi.advanceTimersByTimeAsync(5_000); // tick1：秒级订阅刚建立，尚无帧，回落 adapter.stats()
    expect(statsSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000); // 秒级流吐出第一帧
    await vi.advanceTimersByTimeAsync(4_000); // tick2（t=10s）：已有秒级帧，不再调用 adapter.stats()
    expect(statsSpy).toHaveBeenCalledTimes(1); // 仍是 1 次，没有新增阻塞查询
  });

  it("stop() 收摊秒级容器订阅：之后 latestFastSamples() 不再含容器指标", async () => {
    addModel({ name: "a" });
    await world.runtime.startModel("a");

    const collector = createMetricsCollector({
      adapter: world.adapter,
      db: world.db,
      onSample: () => {},
      fetch: refusedFetch,
      execFile: noNvidia,
    });
    collector.start();
    await vi.advanceTimersByTimeAsync(6_000); // 建立订阅 + 收到一帧
    expect(collector.latestFastSamples()[METRIC_IDS.containerCpuPercent]).toBeDefined();

    collector.stop();
    expect(collector.latestFastSamples()).toEqual({});

    await vi.advanceTimersByTimeAsync(5_000); // stop 后不再有新帧（mock 的 interval 已清）
    expect(collector.latestFastSamples()).toEqual({});
  });

  it("无运行模型：latestFastSamples() 恒为空对象（不订阅、不产快照）", async () => {
    addModel({ name: "a" }); // 配置了但未启动
    const collector = createMetricsCollector({
      adapter: world.adapter,
      db: world.db,
      onSample: () => {},
      fetch: refusedFetch,
      execFile: noNvidia,
    });
    collector.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(collector.latestFastSamples()).toEqual({});
  });

  it("startGpuResidentStream 未开启（默认）：start() 不会拉起 GPU 常驻子进程", () => {
    const spawn = vi.fn() as unknown as SpawnLike;
    const collector = createMetricsCollector({
      adapter: world.adapter,
      db: world.db,
      onSample: () => {},
      execFile: noNvidia,
      spawn,
    });
    collector.start();
    expect(spawn).not.toHaveBeenCalled(); // 默认关闭：测试/未显式开启场景不该背着起真实子进程
  });

  it("startGpuResidentStream 开启：latestFastSamples() 合并 GPU 常驻流秒级快照；stop() kill 常驻子进程", async () => {
    const { proc, stdout, kill } = fakeGpuResidentProcess();
    const spawn: SpawnLike = () => proc;

    const collector = createMetricsCollector({
      adapter: world.adapter,
      db: world.db,
      onSample: () => {},
      execFile: noNvidia,
      spawn,
      startGpuResidentStream: true,
    });
    collector.start();

    stdout.write("0, 8192, 24576, 45, 67, 320.5\n");
    await vi.advanceTimersByTimeAsync(60); // 越过 nvidiaSmi 内部的批聚合防抖窗口

    const fast = collector.latestFastSamples();
    expect(fast[METRIC_IDS.gpuMemUsedMib]).toEqual({ value: 8192, ts: expect.any(Number) });
    expect(fast[METRIC_IDS.gpuUtilPercent]).toEqual({ value: 45, ts: expect.any(Number) });

    collector.stop();
    expect(kill).toHaveBeenCalledTimes(1); // 面板停止心跳时一并 kill 常驻子进程，不留孤儿
  });

  it("startGpuResidentStream 开启：常驻进程异常退出后，节流窗口过后的下一次 5s tick 会自愈重新拉起", async () => {
    const first = fakeGpuResidentProcess();
    const second = fakeGpuResidentProcess();
    const procs = [first, second];
    let n = 0;
    const spawn: SpawnLike = () => procs[n++]!.proc;

    const collector = createMetricsCollector({
      adapter: world.adapter,
      db: world.db,
      onSample: () => {},
      execFile: noNvidia,
      spawn,
      startGpuResidentStream: true,
    });
    collector.start(); // start() 立即 spawn 第一个
    expect(n).toBe(1);

    first.emitExit(); // 模拟常驻进程异常退出（驱动抖动/被 OOM killer 挑中等）

    await vi.advanceTimersByTimeAsync(5_000); // 一轮 5s tick：仍在节流窗口内，不该重新 spawn
    expect(n).toBe(1);

    await vi.advanceTimersByTimeAsync(55_000); // 累计推进到 60s：越过节流窗口
    expect(n).toBe(2); // tick 驱动的 startResident() 自愈重新拉起，不需要人工重启面板
  });

  it("startGpuResidentStream 关闭（默认）：跨多轮 5s tick 都不会拉起 GPU 常驻子进程", async () => {
    const spawn = vi.fn() as unknown as SpawnLike;
    const collector = createMetricsCollector({
      adapter: world.adapter,
      db: world.db,
      onSample: () => {},
      execFile: noNvidia,
      spawn,
    });
    collector.start();
    await vi.advanceTimersByTimeAsync(20_000); // 4 轮心跳
    expect(spawn).not.toHaveBeenCalled(); // 开关关闭：tick 压根不碰常驻流
  });
});

// ---------- 宿主机指标接入（G4：容器视角之外补宿主机 CPU/内存/负载/磁盘/网络） ----------

function cpuInfo(idleMs: number, busyMs: number): os.CpuInfo {
  return { model: "", speed: 0, times: { user: busyMs, nice: 0, sys: 0, idle: idleMs, irq: 0 } };
}

/** 按序返回值的 mock：每次调用推进一格，耗尽后重复最后一个（与 hostStats.test.ts 同款） */
function sequence<T>(values: T[]): () => T {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
}

describe("createMetricsCollector：宿主机指标接入（1s 内部节拍，与 5s 心跳/ring 对接）", () => {
  it("latestFastSamples() 合并宿主机秒级快照（只走 hostStats 自己的 1s 定时器，不涉及 5s 心跳）", async () => {
    addModel({ name: "a" }); // 无运行模型，dockerStats/health 不产样本，专注验证 host 路径

    const collector = createMetricsCollector({
      adapter: world.adapter,
      db: world.db,
      onSample: () => {},
      fetch: refusedFetch,
      execFile: noNvidia,
      startHostStats: true,
      hostStatsDeps: {
        now: sequence([1_000, 2_000]),
        cpus: sequence([[cpuInfo(0, 0)], [cpuInfo(100, 900)]]),
        totalmem: () => 16 * 1024 ** 3,
        freemem: () => 8 * 1024 ** 3,
        loadavg: () => [0.4, 0.3, 0.2],
        readNetDev: async () => null,
        readNetRoute: async () => null,
        statDisk: async () => null,
        readDiskstats: async () => null,
        intervalMs: 1_000,
      },
    });

    collector.start();
    await vi.advanceTimersByTimeAsync(2_000); // host 自己的两轮：早于第一次 5s 心跳，无 tie-break 顾虑

    const fast = collector.latestFastSamples();
    expect(fast[METRIC_IDS.hostCpuPercent]).toEqual({ value: expect.closeTo(90, 6), ts: expect.any(Number) });
    expect(fast[METRIC_IDS.hostMemUsedBytes]).toEqual({ value: 8 * 1024 ** 3, ts: expect.any(Number) });

    collector.stop();
  });

  it("hostDenominators() 透传宿主机 CPU 核数/内存总量/磁盘总量", async () => {
    addModel({ name: "a" });

    const collector = createMetricsCollector({
      adapter: world.adapter,
      db: world.db,
      onSample: () => {},
      fetch: refusedFetch,
      execFile: noNvidia,
      startHostStats: true,
      hostStatsDeps: {
        now: sequence([1_000, 2_000]),
        cpus: sequence([[cpuInfo(0, 0)], [cpuInfo(100, 900)]]),
        totalmem: () => 16 * 1024 ** 3,
        freemem: () => 8 * 1024 ** 3,
        loadavg: () => [0, 0, 0],
        readNetDev: async () => null,
        readNetRoute: async () => null,
        statDisk: async () => ({ freeBytes: 1_000, totalBytes: 2_000 }),
        readDiskstats: async () => null,
        intervalMs: 1_000,
      },
    });

    collector.start();
    expect(collector.hostDenominators()).toEqual({ cpuCount: null, memTotalBytes: null, diskTotalBytes: null });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(collector.hostDenominators()).toEqual({ cpuCount: 1, memTotalBytes: 16 * 1024 ** 3, diskTotalBytes: 2_000 });

    collector.stop();
  });

  it("5s 心跳把宿主机最新帧一并喂进 onSample（跨过第一个 5s 边界）", async () => {
    addModel({ name: "a" });

    const samples: Sample[] = [];
    const collector = createMetricsCollector({
      adapter: world.adapter,
      db: world.db,
      onSample: (sample) => samples.push(sample),
      fetch: refusedFetch,
      execFile: noNvidia,
      startHostStats: true,
      hostStatsDeps: {
        // 6 项：跨过 t=1000..6000（第一次 5s 心跳落在 t=5000 附近，
        // 不断言具体是哪一轮的数值，只验证 host 样本确实流进了 onSample）
        now: sequence([1_000, 2_000, 3_000, 4_000, 5_000, 6_000]),
        cpus: sequence([
          [cpuInfo(0, 0)],
          [cpuInfo(100, 900)],
          [cpuInfo(200, 1800)],
          [cpuInfo(300, 2700)],
          [cpuInfo(400, 3600)],
          [cpuInfo(500, 4500)],
        ]),
        totalmem: () => 16 * 1024 ** 3,
        freemem: () => 8 * 1024 ** 3,
        loadavg: () => [0, 0, 0],
        readNetDev: async () => null,
        readNetRoute: async () => null,
        statDisk: async () => null,
        readDiskstats: async () => null,
        intervalMs: 1_000,
      },
    });

    collector.start();
    await vi.advanceTimersByTimeAsync(6_000); // 越过第一个 5s 心跳边界

    expect(samples.some((s) => s.metric === METRIC_IDS.hostCpuPercent)).toBe(true);
    expect(samples.some((s) => s.metric === METRIC_IDS.hostMemUsedBytes)).toBe(true);
    collector.stop();
  });

  it("stop() 后宿主机内部定时器一并停止，latestFastSamples 不再更新", async () => {
    addModel({ name: "a" });

    const collector = createMetricsCollector({
      adapter: world.adapter,
      db: world.db,
      onSample: () => {},
      fetch: refusedFetch,
      execFile: noNvidia,
      startHostStats: true,
      hostStatsDeps: {
        now: sequence([1_000, 2_000, 3_000, 4_000]),
        cpus: sequence([
          [cpuInfo(0, 0)],
          [cpuInfo(100, 900)],
          [cpuInfo(200, 1800)],
          [cpuInfo(300, 2700)],
        ]),
        totalmem: () => 16 * 1024 ** 3,
        freemem: () => 8 * 1024 ** 3,
        loadavg: () => [0, 0, 0],
        readNetDev: async () => null,
        readNetRoute: async () => null,
        statDisk: async () => null,
        readDiskstats: async () => null,
        intervalMs: 1_000,
      },
    });

    collector.start();
    await vi.advanceTimersByTimeAsync(2_000);
    const before = collector.latestFastSamples();

    collector.stop();
    await vi.advanceTimersByTimeAsync(10_000); // stop 后长时间推进
    expect(collector.latestFastSamples()).toEqual(before); // 未再更新
  });
});
