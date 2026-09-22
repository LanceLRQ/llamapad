/**
 * 模型页二级栏三组（2026-09-21 首页迁移）：首页、仓库档案、配置。编号
 * 01–03 是「固定有序集合」的前导位语义，对照 components/shell/secondary-nav.tsx
 * 的文档注释。顺序是首页 / HuggingFace / 配置。
 *
 * 与 monitoring-tabs 的差别：那边切的是同一页面的视图（`?tab=`），这里三组
 * 各自是独立路由，所以按 pathname 判定。`/models/repos/12`（详情页）也算在
 * repos 组内 —— 二级栏在详情页不该跳回「配置」高亮。
 */
export type ModelsTab = "home" | "repos" | "configs";

export const MODELS_TABS: ReadonlyArray<{ key: ModelsTab; number: string; href: string }> = [
  { key: "home", number: "01", href: "/models" },
  { key: "repos", number: "02", href: "/models/repos" },
  { key: "configs", number: "03", href: "/models/profiles" },
];

// 兜底方向是 configs 而不是 home：配置的子路由（/models/new、/models/<name>/edit
// 与 /duplicate）都该让二级栏高亮「配置」——用户正在编辑一个配置，不是在看首页。
// 所以 home 必须是精确匹配，不能写成"其余全部"
export const DEFAULT_MODELS_TAB: ModelsTab = "configs";

export function resolveModelsTab(pathname: string): ModelsTab {
  if (pathname === "/models/repos" || pathname.startsWith("/models/repos/")) return "repos";
  if (pathname === "/models") return "home";
  return DEFAULT_MODELS_TAB;
}

/** 与 secondary-nav.tsx 的 SecondaryNavItem 逐字段对齐的最小形状——本文件
 *  不 import 组件本身（纯逻辑层不依赖 React），调用方直接展开进 items 数组 */
export interface ModelsTabItem {
  key: ModelsTab;
  href: string;
  selected: boolean;
  name: string;
  meta: string;
  lead: { kind: "number"; text: string };
}

/**
 * 四处路由（`/models`、`/models/repos`、`/models/repos/[id]`、
 * `/models/profiles`）共用的二级栏顶部三条 tab（任务 9 裁定 7；2026-09-21
 * 首页迁移新增 `/models/profiles` 一处）：入参给 pathname 而不是现成的 ModelsTab，
 * 逼着调用方经过 resolveModelsTab 判定——否则这个函数从任务 8 起就一直是
 * 零调用的死代码（四个页面都是 server 组件，各自知道自己的路由，硬写
 * selected 也能跑，但那样 resolveModelsTab 连同它的用例就没有存在的必要）。
 *
 * `t` 只需要认得 `tabs.<key>.name` / `tabs.<key>.meta` 两个键，调用方直接传
 * `getTranslations("pages.models")` / `useTranslations("pages.models")`
 * 的返回值即可，这里不关心具体实现（服务端/客户端两种 t 函数签名一致）。
 */
export function buildModelsTabItems(
  pathname: string,
  t: (key: string) => string,
): ModelsTabItem[] {
  const current = resolveModelsTab(pathname);
  return MODELS_TABS.map(({ key, number, href }) => ({
    key,
    href,
    selected: key === current,
    name: t(`tabs.${key}.name`),
    meta: t(`tabs.${key}.meta`),
    lead: { kind: "number" as const, text: number },
  }));
}
