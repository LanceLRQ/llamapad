import { describe, expect, it } from "vitest";

import { buildRecommendTabs, defaultRecommendTab, showLlmEntry } from "./recommend-tabs";

describe("buildRecommendTabs", () => {
  it("两边都有结果时两个 tab 都在，各带计数", () => {
    expect(buildRecommendTabs(2, 1)).toEqual([
      { key: "rules", count: 2 },
      { key: "llm", count: 1 },
    ]);
  });

  // 规则 0 套时那个 tab 没有存在意义，直接不出现
  it("规则 0 套时只剩 AI tab", () => {
    expect(buildRecommendTabs(0, 1)).toEqual([{ key: "llm", count: 1 }]);
  });

  it("AI 没跑过时 tab 仍在，但不带计数", () => {
    expect(buildRecommendTabs(2, null)).toEqual([
      { key: "rules", count: 2 },
      { key: "llm", count: null },
    ]);
  });

  // 跑完是 0 套与没跑过在 tab 上看起来一样：计数只在有东西时才显示
  it("AI 跑完 0 套同样不带计数", () => {
    expect(buildRecommendTabs(2, 0)).toEqual([
      { key: "rules", count: 2 },
      { key: "llm", count: null },
    ]);
  });

  it("两边都空时只剩 AI tab、无计数 —— 这正是最需要 AI 的场景", () => {
    expect(buildRecommendTabs(0, null)).toEqual([{ key: "llm", count: null }]);
  });
});

describe("defaultRecommendTab", () => {
  it("有规则结果就落规则 tab —— 它零成本且已经在那了", () => {
    expect(defaultRecommendTab(2)).toBe("rules");
  });

  it("规则 0 套时落 AI tab", () => {
    expect(defaultRecommendTab(0)).toBe("llm");
  });
});

describe("showLlmEntry", () => {
  it("两个 tab 都在时显示入口链接", () => {
    expect(showLlmEntry(buildRecommendTabs(2, null))).toBe(true);
  });

  // 只有 AI tab 时用户已经在那一页上了，再放一个"去 AI 解析"的链接是噪声
  it("只剩 AI tab 时隐藏入口链接", () => {
    expect(showLlmEntry(buildRecommendTabs(0, null))).toBe(false);
  });
});
