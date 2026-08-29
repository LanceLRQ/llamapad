import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS_TAB, SETTINGS_TABS, resolveSettingsTab } from "./settings-tabs";

describe("resolveSettingsTab", () => {
  it("四个合法值原样返回", () => {
    for (const { key } of SETTINGS_TABS) {
      expect(resolveSettingsTab(key)).toBe(key);
    }
  });

  it("缺省（undefined）落到 runtime", () => {
    expect(resolveSettingsTab(undefined)).toBe(DEFAULT_SETTINGS_TAB);
  });

  it("非法字符串落到 runtime", () => {
    expect(resolveSettingsTab("nope")).toBe(DEFAULT_SETTINGS_TAB);
  });

  it("空字符串落到 runtime", () => {
    expect(resolveSettingsTab("")).toBe(DEFAULT_SETTINGS_TAB);
  });
});

describe("SETTINGS_TABS", () => {
  it("编号固定 01–04，与 key 顺序一一对应（固定有序集合的前导位语义）", () => {
    expect(SETTINGS_TABS.map((tab) => [tab.key, tab.number])).toEqual([
      ["runtime", "01"],
      ["library", "02"],
      ["monitor", "03"],
      ["account", "04"],
    ]);
  });
});
