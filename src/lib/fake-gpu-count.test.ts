import { describe, expect, it } from "vitest";

import { parseFakeGpuCount } from "./fake-gpu-count";

describe("parseFakeGpuCount", () => {
  it("未设置（undefined）→ null（当作未启用）", () => {
    expect(parseFakeGpuCount(undefined)).toBeNull();
  });

  it("空串 → null", () => {
    expect(parseFakeGpuCount("")).toBeNull();
  });

  it('"0" → null（0 张卡没有意义）', () => {
    expect(parseFakeGpuCount("0")).toBeNull();
  });

  it("负数 → null", () => {
    expect(parseFakeGpuCount("-1")).toBeNull();
  });

  it("非整数（小数）→ null", () => {
    expect(parseFakeGpuCount("4.5")).toBeNull();
  });

  it("非数字字符串 → null，不抛异常", () => {
    expect(parseFakeGpuCount("abc")).toBeNull();
  });

  it("数字后跟脏字符（如 4abc）→ null", () => {
    expect(parseFakeGpuCount("4abc")).toBeNull();
  });

  it("合法正整数 → 原样返回", () => {
    expect(parseFakeGpuCount("4")).toBe(4);
    expect(parseFakeGpuCount("1")).toBe(1);
  });

  it("前后带空白的合法正整数 → trim 后返回", () => {
    expect(parseFakeGpuCount("  8  ")).toBe(8);
  });
});
