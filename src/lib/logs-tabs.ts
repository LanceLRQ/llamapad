/**
 * 日志页二级栏的两组固定分组（M19 任务 14 由 monitoring-tabs.ts 改名而来：
 * 「指标」组已搬进概览页合卡，监控页只剩历史与日志两个排查手段，页面本身
 * 也改名「日志」）。编号 01–02 是「固定有序集合」的前导位语义（对照
 * components/shell/secondary-nav.tsx 的文档注释：固定有序集合用编号、
 * 用户可增删改的集合用计数），顺序错了二级栏的语义就错。
 *
 * resolveLogsTab 兜底：URL query `?tab=` 缺省或给了非法值时落到
 * history——指标搬走后，运行历史是日志页里最先想看的东西，容器日志是
 * 排查具体问题时才会点进去的下一步。
 */
export type LogsTab = "history" | "logs";

export const LOGS_TABS: ReadonlyArray<{ key: LogsTab; number: string }> = [
  { key: "history", number: "01" },
  { key: "logs", number: "02" },
];

export const DEFAULT_LOGS_TAB: LogsTab = "history";

export function resolveLogsTab(raw: string | undefined): LogsTab {
  const hit = LOGS_TABS.find((tab) => tab.key === raw);
  return hit ? hit.key : DEFAULT_LOGS_TAB;
}
