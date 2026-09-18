import { describe, expect, it } from "vitest";
import {
  allocateContainerSlot,
  isPortBindError,
  MAX_HOST_PORT,
  PortExhaustedError,
} from "./port-allocation";

const none = { takenNames: new Set<string>(), takenPorts: new Set<number>() };

describe("allocateContainerSlot：容器名", () => {
  it("配置名未被占用 → 原样使用", () => {
    const slot = allocateContainerSlot({ model: "b", configuredName: "llama-server", configuredPort: 18080, ...none });
    expect(slot.name).toBe("llama-server");
  });

  it("配置名被其他模型占用 → 追加 -<模型名>", () => {
    const slot = allocateContainerSlot({
      model: "qwen3-8b",
      configuredName: "llama-server",
      configuredPort: 18080,
      takenNames: new Set(["llama-server"]),
      takenPorts: new Set(),
    });
    expect(slot.name).toBe("llama-server-qwen3-8b");
  });

  it("带后缀的名字也被占用 → 再追加序号，从 -2 起", () => {
    const slot = allocateContainerSlot({
      model: "b",
      configuredName: "llama-server",
      configuredPort: 18080,
      takenNames: new Set(["llama-server", "llama-server-b", "llama-server-b-2"]),
      takenPorts: new Set(),
    });
    expect(slot.name).toBe("llama-server-b-3");
  });
});

describe("allocateContainerSlot：端口", () => {
  it("配置端口未被占用 → 原样使用", () => {
    const slot = allocateContainerSlot({ model: "a", configuredName: "x", configuredPort: 19000, ...none });
    expect(slot.hostPort).toBe(19000);
  });

  it("配置端口被占用 → 顺延到下一个空闲端口，跳过连续占用段", () => {
    const slot = allocateContainerSlot({
      model: "a",
      configuredName: "x",
      configuredPort: 18080,
      takenNames: new Set(),
      takenPorts: new Set([18080, 18081, 18083]),
    });
    expect(slot.hostPort).toBe(18082);
  });

  it("顺延到 65535 仍无空闲 → 抛 PortExhaustedError（带起始端口）", () => {
    const taken = new Set<number>();
    for (let p = MAX_HOST_PORT - 2; p <= MAX_HOST_PORT; p++) taken.add(p);
    expect(() =>
      allocateContainerSlot({
        model: "a",
        configuredName: "x",
        configuredPort: MAX_HOST_PORT - 2,
        takenNames: new Set(),
        takenPorts: taken,
      }),
    ).toThrow(PortExhaustedError);
  });
});

describe("isPortBindError：识别 docker 的端口冲突报错", () => {
  it("docker-proxy 形态：port is already allocated", () => {
    expect(
      isPortBindError(
        "driver failed programming external connectivity on endpoint llama-server (abc): Bind for 0.0.0.0:18080 failed: port is already allocated",
      ),
    ).toBe(true);
  });

  it("userland proxy 形态：address already in use（大小写不敏感）", () => {
    expect(isPortBindError("Error starting userland proxy: listen tcp4 0.0.0.0:18080: bind: Address already in use")).toBe(true);
  });

  it("其他错误 → false", () => {
    expect(isPortBindError("docker daemon 不可达")).toBe(false);
    expect(isPortBindError("容器启动即退出（exit 1）: CUDA error: out of memory")).toBe(false);
  });
});
