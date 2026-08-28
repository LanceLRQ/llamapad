import { describe, expect, it } from "vitest";
import { normalizeMetaField, QUANT_CANDIDATES, resolveQuantDisplay } from "./quant-labels";

describe("QUANT_CANDIDATES", () => {
  it("候选池非空、全大写、无重复", () => {
    expect(QUANT_CANDIDATES.length).toBeGreaterThan(0);
    for (const c of QUANT_CANDIDATES) {
      expect(c).toBe(c.toUpperCase());
    }
    expect(new Set(QUANT_CANDIDATES).size).toBe(QUANT_CANDIDATES.length);
  });
});

describe("resolveQuantDisplay", () => {
  it("用户值优先于推断值", () => {
    expect(resolveQuantDisplay("Q4_K_M", "Q8_0")).toEqual({ value: "Q4_K_M", source: "user" });
  });

  it("用户未填时展示推断值，并标注来源为 detected", () => {
    expect(resolveQuantDisplay(null, "Q8_0")).toEqual({ value: "Q8_0", source: "detected" });
  });

  it("用户值为空字符串时视同未填，回退到推断值", () => {
    expect(resolveQuantDisplay("   ", "Q8_0")).toEqual({ value: "Q8_0", source: "detected" });
  });

  it("两者都没有时 value 为 null、source 为 none", () => {
    expect(resolveQuantDisplay(null, null)).toEqual({ value: null, source: "none" });
  });

  it("推断值为空字符串时视同没有推断", () => {
    expect(resolveQuantDisplay(null, "   ")).toEqual({ value: null, source: "none" });
  });
});

describe("normalizeMetaField", () => {
  it("去首尾空白", () => {
    expect(normalizeMetaField("  Q4_K_M  ")).toBe("Q4_K_M");
  });

  it("空字符串或纯空白归一为 null（显式清空）", () => {
    expect(normalizeMetaField("")).toBeNull();
    expect(normalizeMetaField("   ")).toBeNull();
  });
});
