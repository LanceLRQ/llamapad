import { describe, expect, it } from "vitest";
import { buildCreateOptions } from "./docker-options";
import type { ContainerSpec } from "./types";

/** 标准 ContainerSpec fixture（对应 default 配置的典型 llama-server 容器） */
function baseSpec(overrides: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    name: "llamapad-llama-server",
    image: "ghcr.io/ggmlorg/llama.cpp:server-cuda",
    hostPort: 18080,
    containerPort: 8080,
    volume: "/srv/llama/models:/models",
    gpu: "all",
    labels: { "llamapad.managed": "true", "llamapad.model": "qwen3.5" },
    args: ["-m", "/models/main/qwen3.5.gguf", "--ctx-size", "131072"],
    ...overrides,
  };
}

describe("buildCreateOptions：GPU 三形态（Mac 无法真机验证，correctness 由本单测锚定）", () => {
  it('gpu="all" → DeviceRequests = [{ Driver:"", Count:-1, Capabilities:[["gpu"]] }]（--gpus all）', () => {
    const options = buildCreateOptions(baseSpec({ gpu: "all" }));
    expect(options.HostConfig?.DeviceRequests).toEqual([
      { Driver: "", Count: -1, Capabilities: [["gpu"]] },
    ]);
  });

  it('gpu="none" → HostConfig 无 DeviceRequests 键（纯 CPU，不传 --gpus）', () => {
    const options = buildCreateOptions(baseSpec({ gpu: "none" }));
    expect(options.HostConfig?.DeviceRequests).toBeUndefined();
  });

  it('gpu="device=0,1" → DeviceRequests = [{ Driver:"", DeviceIDs:["0","1"], Capabilities:[["gpu"]] }]', () => {
    const options = buildCreateOptions(baseSpec({ gpu: "device=0,1" }));
    expect(options.HostConfig?.DeviceRequests).toEqual([
      { Driver: "", DeviceIDs: ["0", "1"], Capabilities: [["gpu"]] },
    ]);
  });

  it('gpu="device=3" 单设备 → DeviceIDs:["3"]', () => {
    const options = buildCreateOptions(baseSpec({ gpu: "device=3" }));
    expect(options.HostConfig?.DeviceRequests).toEqual([
      { Driver: "", DeviceIDs: ["3"], Capabilities: [["gpu"]] },
    ]);
  });
});

describe("buildCreateOptions：端口 / 卷 / 生命周期", () => {
  it("ExposedPorts = {\"8080/tcp\": {}}；PortBindings HostPort 为字符串 \"18080\"", () => {
    const options = buildCreateOptions(baseSpec());
    expect(options.ExposedPorts).toEqual({ "8080/tcp": {} });
    expect(options.HostConfig?.PortBindings).toEqual({
      "8080/tcp": [{ HostPort: "18080" }],
    });
  });

  it("Binds = [spec.volume]；AutoRemove = true（--rm 语义）", () => {
    const options = buildCreateOptions(baseSpec());
    expect(options.HostConfig?.Binds).toEqual(["/srv/llama/models:/models"]);
    expect(options.HostConfig?.AutoRemove).toBe(true);
  });
});

describe("buildCreateOptions：顶层字段", () => {
  it("Image/name/Cmd/Labels/Tty 按 spec 填充；name 为 dockerode options.name", () => {
    const spec = baseSpec();
    const options = buildCreateOptions(spec);
    expect(options.Image).toBe(spec.image);
    expect(options.name).toBe(spec.name);
    expect(options.Cmd).toEqual(spec.args);
    expect(options.Labels).toEqual(spec.labels);
    expect(options.Tty).toBe(false);
  });

  it("User 不设；Env 为空数组或缺省", () => {
    const options = buildCreateOptions(baseSpec());
    expect(options.User).toBeUndefined();
    expect(options.Env === undefined || options.Env.length === 0).toBe(true);
  });

  it("entrypoint 未设置时不产出 Entrypoint 键（沿用镜像自身 entrypoint）", () => {
    const options = buildCreateOptions(baseSpec());
    expect(options.Entrypoint).toBeUndefined();
    expect("Entrypoint" in options).toBe(false);
  });

  it("entrypoint 设置时透传为 dockerode 的 Entrypoint（自定义镜像逃生口，§5.6）", () => {
    const options = buildCreateOptions(baseSpec({ entrypoint: ["/bin/sh", "-c"] }));
    expect(options.Entrypoint).toEqual(["/bin/sh", "-c"]);
  });

  it("纯函数：不修改输入 spec（重复调用结果一致且互不影响）", () => {
    const spec = baseSpec();
    const a = buildCreateOptions(spec);
    const b = buildCreateOptions(spec);
    expect(a).toEqual(b);
    expect(spec.args).toEqual(["-m", "/models/main/qwen3.5.gguf", "--ctx-size", "131072"]);
    expect(spec.labels).toEqual({ "llamapad.managed": "true", "llamapad.model": "qwen3.5" });
  });
});
