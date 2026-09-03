/**
 * 「推荐模型配置」卡的 tab 判定（批 3）
 *
 * 与 logs-tabs.ts / settings-tabs.ts 同形态：判定是纯函数，组件只负责渲染。
 *
 * 三条规则，都来自同一个取向——**tab 不该展示"这里什么都没有"**：
 * - 规则 0 套时那个 tab 整个不出现（而不是出现一个空 tab）
 * - 计数只在真有结果时显示：AI 没跑过与跑完 0 套在 tab 上看起来一样，
 *   区别在面板内部的文案里讲，那里有足够的地方把话说清楚
 * - 只剩一个 tab 时隐藏「不满意？用 LLM 解析」入口——用户已经在那一页上了
 */

export type RecommendTab = "rules" | "llm";

export interface RecommendTabItem {
  key: RecommendTab;
  /** null = 不显示数字 */
  count: number | null;
}

/**
 * @param rulesCount 规则抽取器产出的套数
 * @param llmCount   AI 结果套数；**null 表示从没跑过**，与跑完 0 套是两回事
 */
export function buildRecommendTabs(rulesCount: number, llmCount: number | null): RecommendTabItem[] {
  const tabs: RecommendTabItem[] = [];
  if (rulesCount > 0) tabs.push({ key: "rules", count: rulesCount });
  tabs.push({ key: "llm", count: llmCount !== null && llmCount > 0 ? llmCount : null });
  return tabs;
}

/** 有规则结果就落规则 tab：它零成本、进页面就在那了；没有才落 AI */
export function defaultRecommendTab(rulesCount: number): RecommendTab {
  return rulesCount > 0 ? "rules" : "llm";
}

/** 入口链接只在两个 tab 并存时有意义 */
export function showLlmEntry(tabs: readonly RecommendTabItem[]): boolean {
  return tabs.length > 1;
}
