import { describe, expect, it } from "vitest";

import { DEFAULT_LOGS_TAB, LOGS_TABS, resolveLogsTab } from "./logs-tabs";

describe("resolveLogsTab", () => {
  it("两个合法值原样返回", () => {
    for (const { key } of LOGS_TABS) {
      expect(resolveLogsTab(key)).toBe(key);
    }
  });

  it("缺省（undefined）落到 history", () => {
    expect(resolveLogsTab(undefined)).toBe(DEFAULT_LOGS_TAB);
  });

  it("非法字符串落到 history", () => {
    expect(resolveLogsTab("nope")).toBe(DEFAULT_LOGS_TAB);
  });

  it("空字符串落到 history", () => {
    expect(resolveLogsTab("")).toBe(DEFAULT_LOGS_TAB);
  });
});

describe("LOGS_TABS", () => {
  it("编号固定 01–02，与 key 顺序一一对应（固定有序集合的前导位语义）", () => {
    expect(LOGS_TABS.map((tab) => [tab.key, tab.number])).toEqual([
      ["history", "01"],
      ["logs", "02"],
    ]);
  });
});
