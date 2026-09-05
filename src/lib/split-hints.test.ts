import { describe, expect, it } from "vitest";
import { parseTensorSplit, shouldShowSplitFields, splitHints } from "./split-hints";

/** 不触发任何提示的基线输入：无切分配置、KV 未量化、flash-attn 开 */
const base = {
  splitMode: undefined,
  tensorSplit: undefined,
  mainGpu: undefined,
  cacheK: "f16",
  cacheV: "f16",
  flashAttention: "on",
  visibleCount: 2,
} as const;

const codes = (input: Parameters<typeof splitHints>[0]) => splitHints(input).map((h) => h.code);

describe("parseTensorSplit", () => {
  it("整数与小数都认", () => {
    expect(parseTensorSplit("3,1")).toEqual([3, 1]);
    expect(parseTensorSplit("0.7,0.3")).toEqual([0.7, 0.3]);
    expect(parseTensorSplit("1")).toEqual([1]);
  });
  it("容忍逗号周围空格", () => {
    expect(parseTensorSplit("3, 1")).toEqual([3, 1]);
  });
  it("空串、空项、非数字 → null", () => {
    expect(parseTensorSplit("")).toBeNull();
    expect(parseTensorSplit("3,")).toBeNull();
    expect(parseTensorSplit("3,,1")).toBeNull();
    expect(parseTensorSplit("a,b")).toBeNull();
  });
});

describe("splitHints", () => {
  it("基线输入不产出任何提示", () => {
    expect(splitHints(base)).toEqual([]);
  });

  it("tensor + 量化 KV → tensorKvQuant（内置「均衡」预设正是 q8_0，最常见的撞法）", () => {
    expect(codes({ ...base, splitMode: "tensor", cacheK: "q8_0" })).toContain("tensorKvQuant");
    expect(codes({ ...base, splitMode: "tensor", cacheV: "q4_0" })).toContain("tensorKvQuant");
  });

  it("tensor + 未量化 KV（f16/f32/bf16）不报", () => {
    for (const type of ["f16", "f32", "bf16"]) {
      expect(codes({ ...base, splitMode: "tensor", cacheK: type, cacheV: type })).not.toContain(
        "tensorKvQuant",
      );
    }
  });

  it("非 tensor 模式下量化 KV 不报（约束只属于 tensor）", () => {
    expect(codes({ ...base, splitMode: "layer", cacheK: "q8_0" })).not.toContain("tensorKvQuant");
    expect(codes({ ...base, cacheK: "q8_0" })).not.toContain("tensorKvQuant");
  });

  it("tensor + flash-attn off → tensorFlashAttnOff", () => {
    expect(codes({ ...base, splitMode: "tensor", flashAttention: "off" })).toContain(
      "tensorFlashAttnOff",
    );
  });

  it("row → rowDeprecated（官方已用 tensor 取代；本机 3090 实测直接失败）", () => {
    expect(codes({ ...base, splitMode: "row" })).toEqual(["rowDeprecated"]);
  });

  it("main_gpu 越界 → mainGpuOutOfRange，携带实际值与可见卡数", () => {
    const hints = splitHints({ ...base, mainGpu: 2, visibleCount: 2 });
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({
      field: "main_gpu",
      level: "warn",
      code: "mainGpuOutOfRange",
      values: { actual: 2, count: 2 },
    });
  });

  it("main_gpu 在范围内不报；0 是合法的第一张卡", () => {
    expect(codes({ ...base, mainGpu: 0 })).toEqual([]);
    expect(codes({ ...base, mainGpu: 1, visibleCount: 2 })).toEqual([]);
  });

  it("main_gpu 为 0 但 visibleCount 也为 0 → 仍越界（守卫须用 !== undefined，不能用真值判断）", () => {
    expect(codes({ ...base, mainGpu: 0, visibleCount: 0 })).toContain("mainGpuOutOfRange");
  });

  it("tensor_split 项数与可见卡数不符 → tensorSplitCountMismatch", () => {
    const hints = splitHints({ ...base, tensorSplit: "3,1,1", visibleCount: 2 });
    expect(hints[0]).toMatchObject({
      field: "tensor_split",
      code: "tensorSplitCountMismatch",
      values: { actual: 3, count: 2 },
    });
  });

  it("tensor_split 项数吻合不报", () => {
    expect(codes({ ...base, tensorSplit: "3,1", visibleCount: 2 })).toEqual([]);
  });

  it("tensor_split 解析不出（中间态输入）不报——交给 zod 在预览里报", () => {
    expect(codes({ ...base, tensorSplit: "3,", visibleCount: 2 })).toEqual([]);
  });

  it("visibleCount 为 null（GPU 探测不可用）→ 跳过所有与卡数有关的判定", () => {
    const out = codes({
      ...base,
      visibleCount: null,
      mainGpu: 99,
      tensorSplit: "1,1,1,1,1",
    });
    expect(out).toEqual([]);
  });

  it("visibleCount 为 null 时仍报与卡数无关的提示", () => {
    expect(codes({ ...base, visibleCount: null, splitMode: "row" })).toEqual(["rowDeprecated"]);
  });

  it("多条同时触发时全部返回", () => {
    const out = codes({
      ...base,
      splitMode: "tensor",
      cacheK: "q8_0",
      flashAttention: "off",
      mainGpu: 5,
    });
    expect(out).toEqual(
      expect.arrayContaining(["tensorKvQuant", "tensorFlashAttnOff", "mainGpuOutOfRange"]),
    );
  });
});

describe("shouldShowSplitFields", () => {
  it("多卡 → 显示", () => {
    expect(shouldShowSplitFields({ deviceCount: 2, hasOverride: false })).toBe(true);
  });
  it("单卡且无覆盖 → 隐藏（三个控件对单卡用户是纯噪音）", () => {
    expect(shouldShowSplitFields({ deviceCount: 1, hasOverride: false })).toBe(false);
  });
  it("探测不可用（卡数 0）且无覆盖 → 隐藏", () => {
    expect(shouldShowSplitFields({ deviceCount: 0, hasOverride: false })).toBe(false);
  });
  it("已有覆盖值 → 无条件显示，否则导入来的配置看不见也改不掉", () => {
    expect(shouldShowSplitFields({ deviceCount: 1, hasOverride: true })).toBe(true);
    expect(shouldShowSplitFields({ deviceCount: 0, hasOverride: true })).toBe(true);
  });
});
