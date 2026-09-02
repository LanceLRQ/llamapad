import { describe, expect, it } from "vitest";

import { fitCount } from "./fit-row";

describe("fitCount", () => {
  it("空数组返回 0", () => {
    expect(fitCount([], 8, 100)).toBe(0);
  });

  it("全部放得下时返回全长", () => {
    expect(fitCount([10, 20, 30], 8, 1000)).toBe(3);
  });

  it("累计值恰等于 available 时算放得下（边界不严格小于）", () => {
    // 10 + 8(gap) + 20 = 38，与 available 相等
    expect(fitCount([10, 20], 8, 38)).toBe(2);
  });

  it("第一个就放不下时返回 0", () => {
    expect(fitCount([50], 8, 20)).toBe(0);
  });

  it("gap 参与累加：同样的 widths，gap 变大结果变少", () => {
    const widths = [20, 20, 20, 20];
    const withSmallGap = fitCount(widths, 2, 70);
    const withLargeGap = fitCount(widths, 20, 70);
    expect(withLargeGap).toBeLessThan(withSmallGap);
  });

  it("available 为 0 时返回 0", () => {
    expect(fitCount([10, 20], 8, 0)).toBe(0);
  });

  it("available 为负数时返回 0", () => {
    expect(fitCount([10, 20], 8, -5)).toBe(0);
  });

  it("不做部分显示：放不下的那一项之后即使还有更窄的项也不再继续尝试", () => {
    // 第二项放不下就整体停止，不会跳过它去试第三项（哪怕第三项其实放得下）
    expect(fitCount([10, 50, 1], 8, 30)).toBe(1);
  });
});
