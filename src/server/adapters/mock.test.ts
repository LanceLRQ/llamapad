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
