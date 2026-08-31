/**
 * 模型页二级栏两组（批 4）：配置与仓库档案。编号 01–02 是「固定有序集合」的
 * 前导位语义，对照 components/shell/secondary-nav.tsx 的文档注释。
 *
 * 与 monitoring-tabs 的差别：那边切的是同一页面的视图（`?tab=`），这里两组
 * 各自是独立路由，所以按 pathname 判定。`/models/repos/12`（详情页）也算在
 * repos 组内 —— 二级栏在详情页不该跳回「配置」高亮。
 */
export type ModelsTab = "configs" | "repos";

export const MODELS_TABS: ReadonlyArray<{ key: ModelsTab; number: string; href: string }> = [
  { key: "configs", number: "01", href: "/models" },
  { key: "repos", number: "02", href: "/models/repos" },
];

export const DEFAULT_MODELS_TAB: ModelsTab = "configs";

export function resolveModelsTab(pathname: string): ModelsTab {
  return pathname === "/models/repos" || pathname.startsWith("/models/repos/")
    ? "repos"
    : DEFAULT_MODELS_TAB;
}
