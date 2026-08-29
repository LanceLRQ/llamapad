import { describe, expect, it } from "vitest";

import { formatStat } from "@/lib/page-header";

describe("formatStat", () => {
  it("数字正常值带单位", () => {
    expect(formatStat(60.5, "GB")).toEqual({ text: "60.5", unit: "GB", empty: false });
  });

  it("数字正常值不带单位", () => {
    expect(formatStat(3)).toEqual({ text: "3", unit: null, empty: false });
  });

  it("数字 0 视为空态，不带单位", () => {
    expect(formatStat(0, "GB")).toEqual({ text: "—", unit: null, empty: true });
  });

  it("null 视为空态，不带单位", () => {
    expect(formatStat(null, "GB")).toEqual({ text: "—", unit: null, empty: true });
  });

  it("字符串值原样透传", () => {
    expect(formatStat("60.5", "GB")).toEqual({ text: "60.5", unit: "GB", empty: false });
  });

  it("空字符串视为空态", () => {
    expect(formatStat("", "GB")).toEqual({ text: "—", unit: null, empty: true });
  });

  it("字符串零与数字零同义，视为空态", () => {
    expect(formatStat("0", "GB")).toEqual({ text: "—", unit: null, empty: true });
  });
});
