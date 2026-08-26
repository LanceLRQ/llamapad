/**
 * 终端日志搜索过滤（UX P0 Task 4 / U9）：纯函数，供 terminal.tsx 与单测共用。
 *
 * 语义：大小写不敏感子串匹配，只作用于 log 行；container / waiting / history
 * 元事件行是结构性分隔（换容器 / 等待中 / 重启前历史的分界），无论命中与否
 * 都保留——搜索时它们是定位上下文，过滤掉反而破坏可读性。
 */

export interface FilterableLogEntry {
  key: number;
  kind: "log" | "container" | "waiting" | "history";
  text: string;
}

/** 正则元字符转义（搜索词按字面量匹配） */
export function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 规范化搜索词：去首尾空白；空白视为"不过滤"（null） */
export function normalizeQuery(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function filterEntries<T extends FilterableLogEntry>(entries: T[], rawQuery: string): T[] {
  const query = normalizeQuery(rawQuery);
  if (query === null) return entries;
  const needle = query.toLowerCase();
  return entries.filter(
    (entry) => entry.kind !== "log" || entry.text.toLowerCase().includes(needle),
  );
}

/** 命中计数（只数 log 行，用于 "N 处匹配" 展示） */
export function countMatches(entries: FilterableLogEntry[], rawQuery: string): number {
  const query = normalizeQuery(rawQuery);
  if (query === null) return 0;
  const needle = query.toLowerCase();
  return entries.reduce(
    (sum, entry) =>
      entry.kind === "log" && entry.text.toLowerCase().includes(needle) ? sum + 1 : sum,
    0,
  );
}
