import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockDockerAdapter } from "./mock";
import type { ContainerSpec } from "./types";

/** 构造一份最小可用的 ContainerSpec（含 llamapad.managed 标签） */
function spec(name: string): ContainerSpec {
  return {
    name,
    image: "ghcr.io/ggml-org/llama.cpp:server-cuda",
    hostPort: 18080,
    containerPort: 8080,
    volume: "/srv/llama/models:/models",
    gpu: "all",
    labels: { "llamapad.managed": "true", "llamapad.model": name },
    args: ["-m", `/models/main/${name}.gguf`, "--ctx-size", "131072"],
  };
}

describe("MockDockerAdapter：start / status / isRunning", () => {
  it("start 后 status 返回 running，mock 内部记录 spec（labels 可查），isRunning 为 true", async () => {
    const docker = createMockDockerAdapter();
    const { id } = await docker.start(spec("llama-server"));

    expect(id).toMatch(/^mock-[0-9a-f]+$/);

    const status = await docker.status("llama-server");
    expect(status).not.toBeNull();
    expect(status?.name).toBe("llama-server");
    expect(status?.id).toBe(id);
    expect(status?.state).toBe("running");
    // startedAt 为合法 ISO 时间戳
    expect(status?.startedAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(status!.startedAt!))).toBe(false);

    // mock 内部记录 spec，labels 可查（specOf 为 mock 专属内省方法）
    const recorded = docker.specOf("llama-server");
    expect(recorded?.labels).toEqual({
      "llamapad.managed": "true",
      "llamapad.model": "llama-server",
    });
    expect(recorded?.args[0]).toBe("-m");

    expect(await docker.isRunning("llama-server")).toBe(true);
  });

  it("未 start 的容器 status 为 null、isRunning 为 false", async () => {
    const docker = createMockDockerAdapter();
    expect(await docker.status("nope")).toBeNull();
    expect(await docker.isRunning("nope")).toBe(false);
  });
});

describe("MockDockerAdapter：stop 语义（docker rm）", () => {
  it("stop 后 status 返回 null（容器已移除，与 docker rm 语义一致）、isRunning 为 false", async () => {
    const docker = createMockDockerAdapter();
    await docker.start(spec("llama-server"));

    await docker.stop("llama-server");

    expect(await docker.status("llama-server")).toBeNull();
    expect(await docker.isRunning("llama-server")).toBe(false);
    expect(docker.specOf("llama-server")).toBeNull();
  });

  it("stop 幂等：对不存在/已停止的容器再次 stop 不抛错", async () => {
    const docker = createMockDockerAdapter();
    await expect(docker.stop("never-started")).resolves.toBeUndefined();

    await docker.start(spec("llama-server"));
    await docker.stop("llama-server");
    await expect(docker.stop("llama-server")).resolves.toBeUndefined();
  });

  it("stop 只影响目标容器，其他容器不受影响", async () => {
    const docker = createMockDockerAdapter();
    await docker.start(spec("a"));
    await docker.start(spec("b"));

    await docker.stop("a");

    expect(await docker.isRunning("a")).toBe(false);
    expect(await docker.isRunning("b")).toBe(true);
  });
});

describe("MockDockerAdapter：logs", () => {
  it("返回伪造 llama.cpp 风格日志：每行含时间戳与 llama-server 字样", async () => {
    const docker = createMockDockerAdapter();
    await docker.start(spec("llama-server"));

    const logs = await docker.logs("llama-server");
    const lines = logs.split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line).toContain("llama-server");
      expect(line).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
  });

  it("tail 参数截取最后 N 行", async () => {
    const docker = createMockDockerAdapter();
    await docker.start(spec("llama-server"));

    const all = (await docker.logs("llama-server")).split("\n");
    const tail2 = (await docker.logs("llama-server", 2)).split("\n");

    expect(tail2).toHaveLength(2);
    expect(tail2[0]).toBe(all[all.length - 2]);
    expect(tail2[1]).toBe(all[all.length - 1]);
  });

  it("未启动（含已 stop=已 rm）的容器 logs 返回空串", async () => {
    const docker = createMockDockerAdapter();
    expect(await docker.logs("never-started")).toBe("");

    await docker.start(spec("llama-server"));
    await docker.stop("llama-server");
    expect(await docker.logs("llama-server")).toBe("");
  });
});

describe("MockDockerAdapter：recreate", () => {
  it("start 同名容器先移除旧实例：新 id 生效、旧 spec 被替换", async () => {
    const docker = createMockDockerAdapter();
    const first = await docker.start(spec("llama-server"));
    const second = await docker.start({ ...spec("llama-server"), hostPort: 18081 });

    expect(second.id).not.toBe(first.id);

    const status = await docker.status("llama-server");
    expect(status?.id).toBe(second.id);
    expect(docker.specOf("llama-server")?.hostPort).toBe(18081);
  });
});

describe("MockDockerAdapter：list（按 label 列运行中容器，M1 Task 4）", () => {
  it("label 过滤（key=value 格式）：只返回带该标签的运行中容器", async () => {
    const docker = createMockDockerAdapter();
    // a 带 llamapad.managed=true；b 只有 llamapad.model，不带 managed
    await docker.start({ ...spec("a"), labels: { "llamapad.managed": "true", "llamapad.model": "a" } });
    await docker.start({ ...spec("b"), labels: { "llamapad.model": "b" } });

    const managed = await docker.list({ label: "llamapad.managed=true" });

    expect(managed).toHaveLength(1);
    expect(managed[0]?.name).toBe("a");
    expect(managed[0]?.state).toBe("running");
  });

  it("label 值不匹配的 key=value 不返回（精确匹配，非前缀）", async () => {
    const docker = createMockDockerAdapter();
    await docker.start({ ...spec("a"), labels: { "llamapad.managed": "true" } });

    expect(await docker.list({ label: "llamapad.managed=false" })).toHaveLength(0);
    expect(await docker.list({ label: "llamapad.manage=true" })).toHaveLength(0);
  });

  it("无过滤返回全部运行中容器；stop（=rm）后的容器从结果消失", async () => {
    const docker = createMockDockerAdapter();
    await docker.start(spec("a"));
    await docker.start(spec("b"));

    const all = await docker.list();
    expect(all).toHaveLength(2);
    expect(all.map((c) => c.name).sort()).toEqual(["a", "b"]);

    await docker.stop("a");
    const after = await docker.list();
    expect(after).toHaveLength(1);
    expect(after[0]?.name).toBe("b");
  });

  it("空 label 过滤（undefined）等价无过滤", async () => {
    const docker = createMockDockerAdapter();
    await docker.start(spec("a"));

    expect(await docker.list({})).toHaveLength(1);
  });
});

describe("MockDockerAdapter：status 返回 labels（M1 Task 4）", () => {
  it("status(name).labels 等于 spec.labels", async () => {
    const docker = createMockDockerAdapter();
    const labels = { "llamapad.managed": "true", "llamapad.model": "qwen3.5" };
    await docker.start({ ...spec("llama-server"), labels });

    const status = await docker.status("llama-server");
    expect(status?.labels).toEqual(labels);
  });
});

// ---------- stats（M3 Task 2：指标采集的单帧资源快照） ----------

describe("MockDockerAdapter：stats", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("未 start / 已 stop 的容器 → null", async () => {
    const docker = createMockDockerAdapter();
    expect(await docker.stats("never-started")).toBeNull();
    await docker.start(spec("llama-server"));
    await docker.stop("llama-server");
    expect(await docker.stats("llama-server")).toBeNull();
  });

  it("时间驱动伪值：cpu 正弦 0-100（周期 10s）、mem 随运行秒数递增、ts 取当前时刻", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const docker = createMockDockerAdapter();
    await docker.start(spec("llama-server"));

    // elapsed = 0：sin(0) = 0 → cpu 50；mem 基数 256MiB；网络按 elapsed 线性
    const t0 = Date.now();
    const first = await docker.stats("llama-server");
    expect(first).not.toBeNull();
    expect(first!.cpuPercent).toBeCloseTo(50, 6);
    expect(first!.memBytes).toBe(256 * 1024 * 1024);
    expect(first!.memLimitBytes).toBeGreaterThan(0);
    expect(first!.netRxBytes).toBe(0);
    expect(first!.netTxBytes).toBe(0);
    expect(first!.ts).toBe(t0);

    // elapsed = 2500：sin(π/2) = 1 → cpu 100；mem 每秒 +4MiB
    vi.advanceTimersByTime(2_500);
    const peak = await docker.stats("llama-server");
    expect(peak!.cpuPercent).toBeCloseTo(100, 6);
    expect(peak!.memBytes).toBe(256 * 1024 * 1024 + 2 * 4 * 1024 * 1024);
    expect(peak!.netRxBytes).toBe(2_500 * 2048);

    // elapsed = 7500：sin(3π/2) = -1 → cpu 0（形状断言：正弦有界）
    vi.advanceTimersByTime(5_000);
    const trough = await docker.stats("llama-server");
    expect(trough!.cpuPercent).toBeCloseTo(0, 6);
    expect(trough!.memBytes).toBeGreaterThan(peak!.memBytes); // 递增
  });

  it("两次 stats 的 mem 严格递增（确定性可断言）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const docker = createMockDockerAdapter();
    await docker.start(spec("llama-server"));
    const a = await docker.stats("llama-server");
    vi.advanceTimersByTime(1_000);
    const b = await docker.stats("llama-server");
    expect(b!.memBytes).toBe(a!.memBytes + 4 * 1024 * 1024);
  });
});

// ---------- followLogs（M3 Task 1：SSE 日志流的行级增量） ----------

describe("MockDockerAdapter：followLogs", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("运行中容器每 200ms 推一行伪造日志（<ISO> llama-server: msg #n 风格）", async () => {
    vi.useFakeTimers();
    const docker = createMockDockerAdapter();
    await docker.start(spec("llama-server"));
    const lines: string[] = [];

    const handle = await docker.followLogs("llama-server", (line) => lines.push(line));

    vi.advanceTimersByTime(200);
    expect(lines).toHaveLength(1);
    vi.advanceTimersByTime(400);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z llama-server: msg #\d+$/);
    }
    await handle.stop();
  });

  it("stop 后不再推送，且 stop 幂等（重复调用不抛错）", async () => {
    vi.useFakeTimers();
    const docker = createMockDockerAdapter();
    await docker.start(spec("llama-server"));
    const lines: string[] = [];

    const handle = await docker.followLogs("llama-server", (line) => lines.push(line));
    vi.advanceTimersByTime(600);
    expect(lines).toHaveLength(3);

    await handle.stop();
    await handle.stop(); // 幂等
    vi.advanceTimersByTime(2_000);
    expect(lines).toHaveLength(3);
  });

  it("setLogScript 注入自定义行序列：按序各推一次，播完后静默", async () => {
    vi.useFakeTimers();
    const docker = createMockDockerAdapter();
    await docker.start(spec("llama-server"));
    docker.setLogScript("llama-server", ["alpha", "beta"]);
    const lines: string[] = [];

    const handle = await docker.followLogs("llama-server", (line) => lines.push(line));
    vi.advanceTimersByTime(200);
    expect(lines).toEqual(["alpha"]);
    vi.advanceTimersByTime(200);
    expect(lines).toEqual(["alpha", "beta"]);
    // 脚本播完后不再推送（确定性：不回落到伪造行）
    vi.advanceTimersByTime(2_000);
    expect(lines).toEqual(["alpha", "beta"]);
    await handle.stop();
  });

  it("容器不存在：resolve 立即空转的句柄（不抛错、不推行）", async () => {
    vi.useFakeTimers();
    const docker = createMockDockerAdapter();
    const lines: string[] = [];

    const handle = await docker.followLogs("never-started", (line) => lines.push(line));
    vi.advanceTimersByTime(1_000);
    expect(lines).toHaveLength(0);
    await expect(handle.stop()).resolves.toBeUndefined();
  });

  it("follow 中容器被 stop（=rm）：日志随容器消失，不再推送", async () => {
    vi.useFakeTimers();
    const docker = createMockDockerAdapter();
    await docker.start(spec("llama-server"));
    const lines: string[] = [];

    const handle = await docker.followLogs("llama-server", (line) => lines.push(line));
    vi.advanceTimersByTime(200);
    expect(lines).toHaveLength(1);

    await docker.stop("llama-server");
    vi.advanceTimersByTime(1_000);
    expect(lines).toHaveLength(1);
    await handle.stop();
  });
});

// ---------- followStats（秒级指标采集 代号 B：当前值快照的秒级来源） ----------

describe("MockDockerAdapter：followStats", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("运行中容器每 1s 推一帧，数值与 stats() 同款公式（同一时刻取值一致）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const docker = createMockDockerAdapter();
    await docker.start(spec("llama-server"));
    const samples: Awaited<ReturnType<typeof docker.stats>>[] = [];

    const handle = await docker.followStats("llama-server", (s) => samples.push(s));

    vi.advanceTimersByTime(1_000);
    expect(samples).toHaveLength(1);
    const viaStats = await docker.stats("llama-server");
    expect(samples[0]).toEqual(viaStats); // 同一时刻两条路径公式一致

    vi.advanceTimersByTime(2_000);
    expect(samples).toHaveLength(3);
    await handle.stop();
  });

  it("stop 后不再推送，且 stop 幂等（重复调用不抛错）", async () => {
    vi.useFakeTimers();
    const docker = createMockDockerAdapter();
    await docker.start(spec("llama-server"));
    const samples: unknown[] = [];

    const handle = await docker.followStats("llama-server", (s) => samples.push(s));
    vi.advanceTimersByTime(3_000);
    expect(samples).toHaveLength(3);

    await handle.stop();
    await handle.stop(); // 幂等
    vi.advanceTimersByTime(5_000);
    expect(samples).toHaveLength(3);
  });

  it("容器不存在：resolve 立即空转的句柄（不抛错、不推样本）", async () => {
    vi.useFakeTimers();
    const docker = createMockDockerAdapter();
    const samples: unknown[] = [];

    const handle = await docker.followStats("never-started", (s) => samples.push(s));
    vi.advanceTimersByTime(5_000);
    expect(samples).toHaveLength(0);
    await expect(handle.stop()).resolves.toBeUndefined();
  });

  it("follow 中容器被 stop（=rm）：秒级流随容器消失，不再推送", async () => {
    vi.useFakeTimers();
    const docker = createMockDockerAdapter();
    await docker.start(spec("llama-server"));
    const samples: unknown[] = [];

    const handle = await docker.followStats("llama-server", (s) => samples.push(s));
    vi.advanceTimersByTime(1_000);
    expect(samples).toHaveLength(1);

    await docker.stop("llama-server");
    vi.advanceTimersByTime(3_000);
    expect(samples).toHaveLength(1);
    await handle.stop();
  });
});

// ---------- listImages / removeImage（M5 镜像管理 §5.4） ----------

describe("MockDockerAdapter：pullImage 登记本地镜像 + listImages/removeImage", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("拉取成功后 listImages 能看到该镜像（tag 为镜像名本身）", async () => {
    const docker = createMockDockerAdapter();
    expect(await docker.listImages()).toEqual([]);

    await docker.pullImage("ghcr.io/ggml-org/llama.cpp:server-cuda");

    const images = await docker.listImages();
    expect(images).toHaveLength(1);
    expect(images[0]?.tags).toEqual(["ghcr.io/ggml-org/llama.cpp:server-cuda"]);
    expect(images[0]?.size).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(images[0]!.created))).toBe(false);
  });

  it("removeImage 按 tag 删除；再次删除同一 ref 抛「镜像不存在」", async () => {
    const docker = createMockDockerAdapter();
    await docker.pullImage("ghcr.io/ggml-org/llama.cpp:server");

    await docker.removeImage("ghcr.io/ggml-org/llama.cpp:server");
    expect(await docker.listImages()).toEqual([]);

    await expect(docker.removeImage("ghcr.io/ggml-org/llama.cpp:server")).rejects.toThrow(/不存在/);
  });

  it("removeImage 按 id 删除同样生效", async () => {
    const docker = createMockDockerAdapter();
    await docker.pullImage("ghcr.io/ggml-org/llama.cpp:server-cuda");
    const [image] = await docker.listImages();

    await docker.removeImage(image!.id);
    expect(await docker.listImages()).toEqual([]);
  });

  it("镜像被运行中容器占用时删除拒绝（非 force）；force:true 强制删除", async () => {
    const docker = createMockDockerAdapter();
    await docker.pullImage("ghcr.io/ggml-org/llama.cpp:server-cuda");
    await docker.start(spec("llama-server"));

    await expect(docker.removeImage("ghcr.io/ggml-org/llama.cpp:server-cuda")).rejects.toThrow(/使用/);
    expect(await docker.listImages()).toHaveLength(1);

    await docker.removeImage("ghcr.io/ggml-org/llama.cpp:server-cuda", true);
    expect(await docker.listImages()).toEqual([]);
  });

  it("signal 中止：不再登记镜像、Promise 以错误结束", async () => {
    vi.useFakeTimers();
    const docker = createMockDockerAdapter();
    const controller = new AbortController();

    const promise = docker.pullImage("ghcr.io/ggml-org/llama.cpp:server-cuda", undefined, controller.signal);
    // 断言先挂上（attach .catch）再推进定时器：promise 实际 reject 发生在
    // advanceTimersByTimeAsync 内部，若晚于此才 attach 会被 Node 判定为
    // "unhandled rejection"（哪怕随后确实 await 到了它）
    const assertion = expect(promise).rejects.toThrow(/中止/);
    controller.abort();
    await vi.advanceTimersByTimeAsync(300);
    await assertion;

    expect(await docker.listImages()).toEqual([]);
  });
});

describe("MockDockerAdapter：inspectMounts / setMounts（自动发现宿主机根用）", () => {
  it("未注入过挂载表的 id 返回 null（与容器不存在同语义）", async () => {
    const docker = createMockDockerAdapter();
    expect(await docker.inspectMounts("a1b2c3d4e5f6")).toBeNull();
  });

  it("setMounts 注入后 inspectMounts 原样返回", async () => {
    const docker = createMockDockerAdapter();
    const list = [{ type: "bind", source: "/srv/llama/models", destination: "/host-models" }];
    docker.setMounts("a1b2c3d4e5f6", list);

    expect(await docker.inspectMounts("a1b2c3d4e5f6")).toEqual(list);
  });

  it("挂载表与 start() 记录的容器表是两个概念：注入的 id 与容器名互不影响", async () => {
    const docker = createMockDockerAdapter();
    await docker.start(spec("llama-server"));
    docker.setMounts("a1b2c3d4e5f6", [
      { type: "bind", source: "/srv/llama/models", destination: "/host-models" },
    ]);

    expect(await docker.inspectMounts("llama-server")).toBeNull();
    expect(await docker.status("a1b2c3d4e5f6")).toBeNull();
  });
});
