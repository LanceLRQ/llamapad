/**
 * 监控页二级栏的三组固定分组（M16 后续）：编号 01–03 是「固定有序集合」的
 * 前导位语义（对照 components/shell/secondary-nav.tsx 的文档注释：固定有序
 * 集合用编号、用户可增删改的集合用计数），顺序错了二级栏的语义就错。
 *
 * resolveMonitoringTab 兜底：URL query `?tab=` 缺省或给了非法值时落到
 * metrics——指标是监控页的主诉求（打开监控页第一眼要看的东西），历史与
 * 日志是排查问题时才用得上的回溯手段，不该抢当默认落点。
 */
export type MonitoringTab = "metrics" | "history" | "logs";

export const MONITORING_TABS: ReadonlyArray<{ key: MonitoringTab; number: string }> = [
  { key: "metrics", number: "01" },
  { key: "history", number: "02" },
  { key: "logs", number: "03" },
];

export const DEFAULT_MONITORING_TAB: MonitoringTab = "metrics";

export function resolveMonitoringTab(raw: string | undefined): MonitoringTab {
  const hit = MONITORING_TABS.find((tab) => tab.key === raw);
  return hit ? hit.key : DEFAULT_MONITORING_TAB;
}
