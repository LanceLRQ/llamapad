import { describe, expect, it } from "vitest";

import { gpuMemoryPercent, missingSelectedDevices, pairTensorSplitWithDevices } from "./gpu-device-picker";

describe("gpuMemoryPercent", () => {
  it("按 used/total 算百分比", () => {
    expect(gpuMemoryPercent(2600, 32000)).toBeCloseTo(8.125, 3);
  });

  it("total 为 0 时返回 0，不产出 Infinity", () => {
    expect(gpuMemoryPercent(100, 0)).toBe(0);
  });

  it("total 为负数时返回 0", () => {
    expect(gpuMemoryPercent(100, -1)).toBe(0);
  });

  it("used 超过 total 时夹到 100", () => {
    expect(gpuMemoryPercent(40000, 32000)).toBe(100);
  });

  it("used 为 0 时返回 0", () => {
    expect(gpuMemoryPercent(0, 32000)).toBe(0);
  });
});

describe("missingSelectedDevices", () => {
  it("已勾选但机器上没有的卡号，升序返回", () => {
    expect(missingSelectedDevices([0, 2, 5], [0, 1, 2, 3])).toEqual([5]);
  });

  it("全部存在时返回空数组", () => {
    expect(missingSelectedDevices([0, 1], [0, 1, 2])).toEqual([]);
  });

  it("未勾选任何卡时返回空数组", () => {
    expect(missingSelectedDevices([], [0, 1])).toEqual([]);
  });

  it("机器上没有任何卡时，已勾选的全部缺失", () => {
    expect(missingSelectedDevices([0, 2], [])).toEqual([0, 2]);
  });

  it("重复项去重", () => {
    expect(missingSelectedDevices([5, 5, 6], [0])).toEqual([5, 6]);
  });
});

describe("pairTensorSplitWithDevices", () => {
  it("按位置配对比例与可见卡号", () => {
    expect(pairTensorSplitWithDevices([3, 1], [2, 3])).toEqual([
      { index: 2, ratio: 3 },
      { index: 3, ratio: 1 },
    ]);
  });

  it("项数不一致时返回 null", () => {
    expect(pairTensorSplitWithDevices([3, 1, 1], [2, 3])).toBeNull();
  });

  it("两边都为空时返回 null（无卡可配对）", () => {
    expect(pairTensorSplitWithDevices([], [])).toBeNull();
  });
});
