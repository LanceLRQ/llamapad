import { describe, expect, it } from "vitest";

import { initiallyExpanded } from "./relay-layout";

const svc = (model: string, isDefault = false) => ({ model, isDefault });

describe("initiallyExpanded", () => {
  it("没有托管模型 → 空集", () => {
    expect(initiallyExpanded([])).toEqual(new Set());
  });

  it("只有 1 个 → 它展开，不论是否默认", () => {
    expect(initiallyExpanded([svc("a")])).toEqual(new Set(["a"]));
    expect(initiallyExpanded([svc("a", true)])).toEqual(new Set(["a"]));
  });

  it("多个 → 只有默认模型展开", () => {
    expect(initiallyExpanded([svc("a"), svc("b", true), svc("c")])).toEqual(new Set(["b"]));
  });

  it("多个且没有默认 → 全部收起", () => {
    expect(initiallyExpanded([svc("a"), svc("b")])).toEqual(new Set());
  });
});
