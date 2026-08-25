import Docker from "dockerode";
import type dockerode from "dockerode";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildFollowLogOptions,
  containerStatsToSample,
  createDockerodeAdapter,
  isDockerodeAdapter,
  type DockerodeAdapter,
} from "./dockerode";
import { getDockerAdapter } from "./index";
import type { ContainerSpec } from "./types";

/**
 * dockerode 真实适配器测试（M1 Task 5）
 *
 * 两组测试：
 * 1. 单测（始终运行，不触碰 Docker daemon）：socket 路径解析 + 工厂分发。
 *    dockerode 连接是惰性的——构造 `new Docker({socketPath})` 不发起任何 IO，
 *    所以无 Docker 环境也能构造适配器做断言。
 * 2. 集成测试（describe.skipIf(!DOCKER_TESTS)，DOCKER_TESTS=1 才跑）：
 *    真实 Docker daemon 上的 alpine 生命周期 / 启动即退 / logs。
 *    Mac Docker Desktop 不支持 --gpus，集成测试只用 gpu:"none"。
 */

/** 读写环境变量后还原，避免污染其他测试（同 index.test.ts 的 withEnv 模式） */
function withEnv(key: string, value: string | undefined, fn: () => void | Promise<void>) {
  return async () => {
    const prev = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  };
}

describe("createDockerodeAdapter：socket 路径解析（无 IO，不依赖 Docker daemon）", () => {
  it(
    "默认 socketPath 为 /var/run/docker.sock",
    withEnv("PANEL_DOCKER_SOCKET", undefined, () => {
      expect(createDockerodeAdapter().socketPath).toBe("/var/run/docker.sock");
    }),
  );

  it(
    "PANEL_DOCKER_SOCKET 可覆盖默认 socket 路径",
    withEnv("PANEL_DOCKER_SOCKET", "/tmp/llamapad-test.sock", () => {
      expect(createDockerodeAdapter().socketPath).toBe("/tmp/llamapad-test.sock");
    }),
  );

  it("显式参数优先于环境变量", async () => {
    const prev = process.env.PANEL_DOCKER_SOCKET;
    process.env.PANEL_DOCKER_SOCKET = "/tmp/from-env.sock";
    try {
      expect(createDockerodeAdapter("/tmp/explicit.sock").socketPath).toBe("/tmp/explicit.sock");
    } finally {
      if (prev === undefined) delete process.env.PANEL_DOCKER_SOCKET;
      else process.env.PANEL_DOCKER_SOCKET = prev;
    }
  });
});

describe("getDockerAdapter：PANEL_DOCKER=mock|real 工厂分发", () => {
  it(
    "PANEL_DOCKER=real 返回 dockerode 实现（isDockerodeAdapter 判别，具备 list 方法）",
    withEnv("PANEL_DOCKER", "real", () => {
      const docker = getDockerAdapter();
      expect(isDockerodeAdapter(docker)).toBe(true);
      expect(typeof docker.list).toBe("function");
    }),
  );

  it(
    "PANEL_DOCKER=mock 返回 mock（isDockerodeAdapter 为 false）",
    withEnv("PANEL_DOCKER", "mock", () => {
      expect(isDockerodeAdapter(getDockerAdapter())).toBe(false);
    }),
  );

  it(
    "未设置 PANEL_DOCKER 默认返回 mock",
    withEnv("PANEL_DOCKER", undefined, () => {
      expect(isDockerodeAdapter(getDockerAdapter())).toBe(false);
    }),
  );

  it(
    "PANEL_DOCKER=whatever 抛错",
    withEnv("PANEL_DOCKER", "whatever", () => {
      expect(() => getDockerAdapter()).toThrow(/PANEL_DOCKER=whatever/);
    }),
  );
});

describe("buildFollowLogOptions：followLogs 的 logs API 选项组装（无 IO）", () => {
  it("follow + stdout/stderr + tail 100（≈ docker logs -f --tail 100）", () => {
    expect(buildFollowLogOptions()).toEqual({
      follow: true,
      stdout: true,
      stderr: true,
      tail: 100,
    });
  });
});

// ---------- stats 单帧 → ContainerStatsSample 公式（M3 Task 2，无 IO） ----------

/** 构造 docker stats 单帧（stream:false 返回的 JSON）的最小形态 */
function statsFrame(over: {
  cpuTotal?: number;
  preCpuTotal?: number;
  systemUsage?: number;
  preSystemUsage?: number;
  onlineCpus?: number;
  percpuUsage?: number[];
  memUsage?: number;
  memLimit?: number;
  networks?: Record<string, { rx_bytes: number; tx_bytes: number }>;
}): dockerode.ContainerStats {
  return {
    read: "2026-01-01T00:00:01Z",
    preread: "2026-01-01T00:00:00Z",
    num_procs: 0,
    cpu_stats: {
      cpu_usage: {
        total_usage: over.cpuTotal ?? 0,
        percpu_usage: over.percpuUsage ?? [],
        usage_in_usermode: 0,
        usage_in_kernelmode: 0,
      },
      system_cpu_usage: over.systemUsage ?? 0,
      online_cpus: over.onlineCpus ?? 0,
      throttling_data: { periods: 0, throttled_periods: 0, throttled_time: 0 },
    },
    precpu_stats: {
      cpu_usage: {
        total_usage: over.preCpuTotal ?? 0,
        percpu_usage: [],
        usage_in_usermode: 0,
        usage_in_kernelmode: 0,
      },
      system_cpu_usage: over.preSystemUsage ?? 0,
      online_cpus: 0,
      throttling_data: { periods: 0, throttled_periods: 0, throttled_time: 0 },
    },
    memory_stats: {
      stats: {} as dockerode.MemoryStats["stats"],
      max_usage: 0,
      usage: over.memUsage ?? 0,
      failcnt: 0,
      limit: over.memLimit ?? 0,
    },
    networks: over.networks ?? {},
    // 最小帧：只填公式用到的字段，经 unknown 收窄到 ContainerStats
  } as unknown as dockerode.ContainerStats;
}

describe("containerStatsToSample：CPU%/内存/网络公式（纯函数）", () => {
  it("CPU% = (cpuΔ / systemΔ) × online_cpus × 100；内存取 usage/limit；网络各接口 rx/tx 求和", () => {
    const sample = containerStatsToSample(
      statsFrame({
        cpuTotal: 160,
        preCpuTotal: 100, // cpuΔ = 60
        systemUsage: 2_000,
        preSystemUsage: 1_000, // systemΔ = 1000
        onlineCpus: 4, // 0.06 × 4 × 100 = 24
        memUsage: 512 * 1024 * 1024,
        memLimit: 1024 * 1024 * 1024,
        networks: {
          eth0: { rx_bytes: 100, tx_bytes: 50 },
          eth1: { rx_bytes: 10, tx_bytes: 5 },
        },
      }),
      123_456,
    );

    expect(sample.cpuPercent).toBeCloseTo(24, 6);
    expect(sample.memBytes).toBe(512 * 1024 * 1024);
    expect(sample.memLimitBytes).toBe(1024 * 1024 * 1024);
    expect(sample.netRxBytes).toBe(110);
    expect(sample.netTxBytes).toBe(55);
    expect(sample.ts).toBe(123_456);
  });

  it("systemΔ 为 0（首帧/时钟异常）→ CPU% 0，不抛错", () => {
    const sample = containerStatsToSample(
      statsFrame({ cpuTotal: 100, preCpuTotal: 50, systemUsage: 1_000, preSystemUsage: 1_000 }),
      0,
    );
    expect(sample.cpuPercent).toBe(0);
  });

  it("cpuΔ 为负（计数器回绕）→ CPU% 0", () => {
    const sample = containerStatsToSample(
      statsFrame({ cpuTotal: 40, preCpuTotal: 90, systemUsage: 2_000, preSystemUsage: 1_000 }),
      0,
    );
    expect(sample.cpuPercent).toBe(0);
  });

  it("CPU% clamp 到 0-400（0.9 × 8 核 × 100 = 720 → 400）", () => {
    const sample = containerStatsToSample(
      statsFrame({
        cpuTotal: 1_900,
        preCpuTotal: 1_000, // cpuΔ = 900 → 0.9
        systemUsage: 2_000,
        preSystemUsage: 1_000, // systemΔ = 1000
        onlineCpus: 8,
      }),
      0,
    );
    expect(sample.cpuPercent).toBe(400);
  });

  it("online_cpus 缺省（0）时回退 percpu_usage 数量；usage 缺失 → mem 0；networks 缺失 → 0", () => {
    const sample = containerStatsToSample(
      statsFrame({
        cpuTotal: 100,
        preCpuTotal: 50, // cpuΔ = 50
        systemUsage: 1_000,
        preSystemUsage: 0, // systemΔ = 1000
        onlineCpus: 0,
        percpuUsage: [0, 0, 0, 0], // 回退 4 核 → 0.05 × 4 × 100 = 20
        memUsage: undefined,
        memLimit: 1024,
        networks: undefined,
      }),
      0,
    );
    expect(sample.cpuPercent).toBeCloseTo(20, 6);
    expect(sample.memBytes).toBe(0);
    expect(sample.memLimitBytes).toBe(1024);
    expect(sample.netRxBytes).toBe(0);
    expect(sample.netTxBytes).toBe(0);
  });
});

/**
 * ======================= 集成测试（需真实 Docker） =======================
 * DOCKER_TESTS=1 npm test 时运行；默认跳过。
 * 容器名带随机后缀避免冲突；afterAll 对每个创建过的容器名尽力 kill 清理。
 * start 的"启动即退检测"轮询 2s×5 次，成功路径也要等满 10s——用例级 timeout 放宽到 30s。
 */
describe.skipIf(!process.env.DOCKER_TESTS)("dockerode 真实适配器：alpine 集成测试", () => {
  let adapter: DockerodeAdapter;
  /** 本用例组创建过的容器名，afterAll 统一清理 */
  const created: string[] = [];
  const rand = () => randomBytes(3).toString("hex");

  /** alpine 集成测试用 spec：gpu:"none"（Mac Docker Desktop 不支持 --gpus） */
  function alpineSpec(name: string, args: string[]): ContainerSpec {
    return {
      name,
      image: "alpine:latest",
      hostPort: 0, // HostPort:"0" → docker 随机分配宿主端口
      containerPort: 8080,
      volume: "/tmp:/tmp",
      gpu: "none",
      labels: { "llamapad.managed": "true" },
      args,
    };
  }

  beforeAll(async () => {
    adapter = createDockerodeAdapter();
    // 幂等确保 alpine:latest 存在：listImages 检查 RepoTags，缺失则 pull（走 Docker Desktop 自身网络）
    const docker = new Docker({ socketPath: adapter.socketPath });
    const images = await docker.listImages();
    const has = images.some((img) => (img.RepoTags ?? []).includes("alpine:latest"));
    if (!has) {
      const stream = await docker.pull("alpine:latest");
      await new Promise<void>((resolve, reject) => {
        docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
      });
    }
  }, 180_000);

  afterAll(async () => {
    for (const name of created) {
      try {
        await adapter.stop(name);
      } catch {
        // 清理尽力而为：容器可能已退出并被 AutoRemove 移除（404）
      }
    }
  });

  it(
    "生命周期：start → isRunning/status/labels → list(label) → stop → status null → 再 stop 幂等",
    async () => {
      const name = `llamapad-it-life-${rand()}`;
      created.push(name);
      const { id } = await adapter.start(alpineSpec(name, ["sleep", "60"]));
      expect(id).toMatch(/^[0-9a-f]{12}$/);

      expect(await adapter.isRunning(name)).toBe(true);

      const status = await adapter.status(name);
      expect(status?.name).toBe(name);
      expect(status?.state).toBe("running");
      expect(status?.labels).toEqual({ "llamapad.managed": "true" });

      const listed = await adapter.list({ label: "llamapad.managed=true" });
      expect(listed.map((c) => c.name)).toContain(name);

      await adapter.stop(name);
      expect(await adapter.status(name)).toBeNull();
      // 幂等：容器不存在时再 stop 不抛
      await expect(adapter.stop(name)).resolves.toBeUndefined();
    },
    30_000,
  );

  it(
    "启动即退：错误消息含 stderr 摘要（boom），容器随后已被 AutoRemove（status null）",
    async () => {
      const name = `llamapad-it-die-${rand()}`;
      created.push(name);
      await expect(adapter.start(alpineSpec(name, ["sh", "-c", "echo boom >&2; exit 1"]))).rejects.toThrow(/boom/);
      expect(await adapter.status(name)).toBeNull();
    },
    30_000,
  );

  it(
    "logs：demux 合并 stdout/stderr 后包含 hello-log",
    async () => {
      const name = `llamapad-it-log-${rand()}`;
      created.push(name);
      await adapter.start(alpineSpec(name, ["sh", "-c", "echo hello-log; sleep 30"]));
      const text = await adapter.logs(name, 10);
      expect(text).toContain("hello-log");
      await adapter.stop(name);
      expect(await adapter.status(name)).toBeNull();
    },
    30_000,
  );

  it(
    "followLogs：行级增量（alpine echo line-a / sleep / echo line-b），收到恰好 2 行，stop 幂等",
    async () => {
      const name = `llamapad-it-follow-${rand()}`;
      created.push(name);
      // start 的启动检测轮询 ~10s 才返回：sleep 12 保证容器活过该窗口，
      // 且 line-b 在 attach 之后才产出——line-a 经 tail:100 补发、line-b 实时到达，
      // 一条用例同时盖住补发与 follow 两段路径（末尾 sleep 60 维持运行态）
      await adapter.start(alpineSpec(name, ["sh", "-c", "echo line-a; sleep 12; echo line-b; sleep 60"]));

      const lines: string[] = [];
      const handle = await adapter.followLogs(name, (line) => lines.push(line));

      const deadline = Date.now() + 15_000;
      while (lines.length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      // 恰好两行、逐行回调（非收尾拼接），证明行分割器在复用流上按 \n 增量切行
      expect(lines).toEqual(["line-a", "line-b"]);

      await handle.stop();
      await expect(handle.stop()).resolves.toBeUndefined(); // 幂等
    },
    45_000,
  );

  it(
    "followLogs：容器不存在（404）→ 静默空句柄，stop 不抛错",
    async () => {
      const lines: string[] = [];
      const handle = await adapter.followLogs(`llamapad-it-absent-${rand()}`, (line) => lines.push(line));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(lines).toHaveLength(0);
      await expect(handle.stop()).resolves.toBeUndefined();
    },
    15_000,
  );

  it(
    "stats：运行中容器返回非 null 单帧（形状断言），容器移除后 → null（M3 Task 2）",
    async () => {
      const name = `llamapad-it-stats-${rand()}`;
      created.push(name);
      await adapter.start(alpineSpec(name, ["sleep", "60"]));

      const sample = await adapter.stats(name);
      expect(sample).not.toBeNull();
      expect(sample!.cpuPercent).toBeGreaterThanOrEqual(0);
      expect(sample!.cpuPercent).toBeLessThanOrEqual(400);
      expect(sample!.memLimitBytes).toBeGreaterThan(0);
      expect(sample!.ts).toBeGreaterThan(0);

      await adapter.stop(name);
      expect(await adapter.stats(name)).toBeNull();
    },
    30_000,
  );
});
