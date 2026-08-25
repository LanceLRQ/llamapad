import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, runMigrations } from "../db";
import { createMockDockerAdapter } from "../adapters/mock";
import { createModelRepo } from "../repo/models";
import { createRuntimeService } from "../runtime";
import { createMetricsCollector } from "./collector";
import { METRIC_IDS, type Sample } from "./ids";
import type { FetchLike } from "./health";
import type { ExecFileLike } from "./nvidiaSmi";
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
    let prompt = 0;
    let predicted = 0;
    const fetchMock: FetchLike = (url) => {
      urls.push(url);
      if (url.endsWith("/health")) return Promise.resolve(new Response(JSON.stringify({ slots_running: 1 }), { status: 200 }));
      return Promise.resolve(
        new Response(`llama_prompt_tokens_total ${prompt}\nllama_tokens_predicted_total ${predicted}\n`, { status: 200 }),
      );
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
    await vi.advanceTimersByTimeAsync(5_000); // 第一轮：health 样本 + tokens 基线
    expect(urls.every((u) => u.startsWith("http://127.0.0.1:18777/"))).toBe(true);
    expect(samples.filter((s) => s.metric === METRIC_IDS.inferSlotsRunning)).toHaveLength(1);

    prompt = 100;
    predicted = 200;
    await vi.advanceTimersByTimeAsync(5_000); // 第二轮：(100+200)/5 = 60 tokens/s
    const tokens = samples.filter((s) => s.metric === METRIC_IDS.inferTokensPerSec);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].value).toBe(60);
  });
});
