import { describe, expect, it } from "vitest";
import { buildContainerEnv, deviceIndexMap, visibleDevices } from "./gpu-visibility";

/** 测试用的最小分卡形态（真实类型见 server/metrics/nvidiaSmi.ts 的 GpuDevice） */
const devices = [{ index: 0 }, { index: 1 }, { index: 2 }];

describe("deviceIndexMap", () => {
  it('"device=1,2" → [1,2]：容器内编号 0/1 分别对应宿主机 GPU1/GPU2', () => {
    expect(deviceIndexMap("device=1,2")).toEqual([1, 2]);
  });
  it('"device=3" 单卡 → [3]', () => {
    expect(deviceIndexMap("device=3")).toEqual([3]);
  });
  it('"all" → null：编号一致，无需重映射提示', () => {
    expect(deviceIndexMap("all")).toBeNull();
  });
  it('"none" 与未知形态 → null', () => {
    expect(deviceIndexMap("none")).toBeNull();
    expect(deviceIndexMap("gpu0")).toBeNull();
  });
  it("device= 后为空、含非数字、含空项 → null（不臆测用户意图）", () => {
    expect(deviceIndexMap("device=")).toBeNull();
    expect(deviceIndexMap("device=0,x")).toBeNull();
    expect(deviceIndexMap("device=0,,1")).toBeNull();
  });
  it("容忍逗号周围空格", () => {
    expect(deviceIndexMap("device=0, 2")).toEqual([0, 2]);
  });
});

describe("visibleDevices", () => {
  it('"all" → 全部卡，且返回新数组不共享引用', () => {
    const out = visibleDevices(devices, "all");
    expect(out).toEqual(devices);
    expect(out).not.toBe(devices);
  });
  it('"none" → 空数组', () => {
    expect(visibleDevices(devices, "none")).toEqual([]);
  });
  it('"device=0,2" → 按 index 过滤命中的两张卡', () => {
    expect(visibleDevices(devices, "device=0,2")).toEqual([{ index: 0 }, { index: 2 }]);
  });
  it("声明了机器上不存在的卡号 → 该项不命中（不报错、不伪造）", () => {
    expect(visibleDevices(devices, "device=5")).toEqual([]);
    expect(visibleDevices(devices, "device=1,5")).toEqual([{ index: 1 }]);
  });
  it("未知形态 → 空数组，与 docker-options 把未知形态当 CPU 的取舍一致", () => {
    expect(visibleDevices(devices, "gpu0")).toEqual([]);
  });
  it("空卡列表 → 恒为空数组", () => {
    expect(visibleDevices([], "all")).toEqual([]);
  });
});

describe("buildContainerEnv", () => {
  it("无用户 env 且用 GPU → 只注入 CUDA_DEVICE_ORDER", () => {
    expect(buildContainerEnv([], "all")).toEqual(["CUDA_DEVICE_ORDER=PCI_BUS_ID"]);
  });
  it("有用户 env → 注入项在前，用户项原序保留在后", () => {
    expect(buildContainerEnv(["A=1", "B=2"], "device=0")).toEqual([
      "CUDA_DEVICE_ORDER=PCI_BUS_ID",
      "A=1",
      "B=2",
    ]);
  });
  it("用户自己写了 CUDA_DEVICE_ORDER → 原样返回，用户显式优先", () => {
    expect(buildContainerEnv(["CUDA_DEVICE_ORDER=FASTEST_FIRST"], "all")).toEqual([
      "CUDA_DEVICE_ORDER=FASTEST_FIRST",
    ]);
  });
  it('gpu="none" 且无用户 env → undefined（纯 CPU 容器不塞死配置，保持现状不产出 env 键）', () => {
    expect(buildContainerEnv([], "none")).toBeUndefined();
  });
  it('gpu="none" 但有用户 env → 原样返回用户项，不注入', () => {
    expect(buildContainerEnv(["A=1"], "none")).toEqual(["A=1"]);
  });
});
