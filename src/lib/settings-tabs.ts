/**
 * 设置页二级栏的四组固定分组（M16 T4a）：编号 01–04 是「固定有序集合」的
 * 前导位语义（对照 components/shell/secondary-nav.tsx 的文档注释：固定有序
 * 集合用编号、用户可增删改的集合用计数），顺序错了二级栏的语义就错。
 *
 * resolveSettingsTab 兜底：URL query `?tab=` 缺省或给了非法值时落到
 * runtime——环境问题优先于配置，与 DoctorCard 排第一位同一理由。
 */
export type SettingsTab = "runtime" | "library" | "monitor" | "account";

export const SETTINGS_TABS: ReadonlyArray<{ key: SettingsTab; number: string }> = [
  { key: "runtime", number: "01" },
  { key: "library", number: "02" },
  { key: "monitor", number: "03" },
  { key: "account", number: "04" },
];

export const DEFAULT_SETTINGS_TAB: SettingsTab = "runtime";

export function resolveSettingsTab(raw: string | undefined): SettingsTab {
  const hit = SETTINGS_TABS.find((tab) => tab.key === raw);
  return hit ? hit.key : DEFAULT_SETTINGS_TAB;
}
