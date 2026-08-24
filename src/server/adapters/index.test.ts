import { describe, expect, it } from "vitest";
import type { ContainerSpec } from "./types";
import { getDockerAdapter } from "./index";

/** 读写 PANEL_DOCKER 后还原，避免污染其他测试 */
function withEnv(value: string | undefined, fn: () => void | Promise<void>) {
  return async () => {
    const prev = process.env.PANEL_DOCKER;
    if (value === undefined) delete process.env.PANEL_DOCKER;
    else process.env.PANEL_DOCKER = value;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.PANEL_DOCKER;
      else process.env.PANEL_DOCKER = prev;
    }
  };
}

function spec(name: string): ContainerSpec {
  return {
    name,
    image: "ghcr.io/ggml-org/llama.cpp:server-cuda",
    hostPort: 18080,
    containerPort: 8080,
    volume: "/srv/llama/models:/models",
    gpu: "all",
    labels: { "llamapad.managed": "true" },
    args: ["-m", `/models/main/${name}.gguf`],
  };
}

describe("getDockerAdapter（PANEL_DOCKER=mock|real，M0 仅 mock）", () => {
  it(
    "默认（未设置 PANEL_DOCKER）返回 mock：具备 DockerAdapter 全部方法且为内存行为",
    withEnv(undefined, async () => {
      const docker = getDockerAdapter();
      for (const method of ["start", "stop", "status", "isRunning", "logs"] as const) {
        expect(typeof docker[method]).toBe("function");
      }
      // 内存 mock 行为：start 后立即可查、stop（=rm）后 status 为 null
      await docker.start(spec("adapter-default"));
      expect(await docker.isRunning("adapter-default")).toBe(true);
      await docker.stop("adapter-default");
      expect(await docker.status("adapter-default")).toBeNull();
    }),
  );

  it(
    "PANEL_DOCKER=mock 显式返回 mock",
    withEnv("mock", async () => {
      const docker = getDockerAdapter();
      await docker.start(spec("adapter-explicit"));
      expect(await docker.isRunning("adapter-explicit")).toBe(true);
      await docker.stop("adapter-explicit");
      expect(await docker.isRunning("adapter-explicit")).toBe(false);
    }),
  );

  it("单例：进程内多次调用返回同一实例（贴近单 Docker daemon 语义）", () => {
    expect(getDockerAdapter()).toBe(getDockerAdapter());
  });
});
