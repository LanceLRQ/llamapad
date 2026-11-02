/** 模型模块的三个路由入口。仓库详情归仓库档案，配置编辑流程归配置列表。 */
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
