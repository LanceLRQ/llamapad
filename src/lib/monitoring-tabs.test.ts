import { describe, expect, it } from "vitest";

import { DEFAULT_MONITORING_TAB, MONITORING_TABS, resolveMonitoringTab } from "./monitoring-tabs";

describe("resolveMonitoringTab", () => {
  it("三个合法值原样返回", () => {
    for (const { key } of MONITORING_TABS) {
      expect(resolveMonitoringTab(key)).toBe(key);
    }
  });

  it("缺省（undefined）落到 metrics", () => {
    expect(resolveMonitoringTab(undefined)).toBe(DEFAULT_MONITORING_TAB);
  });

  it("非法字符串落到 metrics", () => {
    expect(resolveMonitoringTab("nope")).toBe(DEFAULT_MONITORING_TAB);
  });

  it("空字符串落到 metrics", () => {
    expect(resolveMonitoringTab("")).toBe(DEFAULT_MONITORING_TAB);
  });
});

describe("MONITORING_TABS", () => {
  it("编号固定 01–03，与 key 顺序一一对应（固定有序集合的前导位语义）", () => {
    expect(MONITORING_TABS.map((tab) => [tab.key, tab.number])).toEqual([
      ["metrics", "01"],
      ["history", "02"],
      ["logs", "03"],
    ]);
  });
});
