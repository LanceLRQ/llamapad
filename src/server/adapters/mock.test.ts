import { describe, expect, it } from "vitest";
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
