/**
 * 档案详情页「README / 文件」两视图的判定（HF README 视图）
 *
 * 与 lib/models-tabs.ts 的差别：那两条是独立路由（按 pathname 判定），这两条是
 * 同一页面的视图切换（按 `?view=` 判定），所以不带 href，交给 SecondaryNav 的
 * query 型分支。两组会在同一个 SecondaryNav 里混排，四条项都显式传 selected。
 */

export type RepoView = "readme" | "files";

/** settings 表里记「下次直接进文件列表」的键；写入走 PUT /api/v1/settings/:key */
export const REPO_README_LANDING_KEY = "repo_readme_landing";

export const REPO_VIEWS: ReadonlyArray<{ key: RepoView; number: string }> = [
  { key: "readme", number: "01" },
  { key: "files", number: "02" },
];

/**
 * settings 值 → 是否落地 README。
 * **未设置视为落地 README**：新用户第一次进档案，该先看到模型卡；想跳过是一次
 * 显式选择（勾复选框），不是缺省。非法值一并按缺省处理，坏数据不该让页面白屏。
 */
export function parseLandingSetting(value: string | undefined): boolean {
  return value !== "0";
}

/** URL 优先于落地设置：用户点了页签就该听他的，落地设置只管「没点的时候去哪」 */
export function resolveRepoView(param: string | undefined, landingReadme: boolean): RepoView {
  if (param === "readme" || param === "files") return param;
  return landingReadme ? "readme" : "files";
}

/** 与 secondary-nav.tsx 的 SecondaryNavItem 逐字段对齐的最小形状（纯逻辑层不依赖 React） */
export interface RepoViewItem {
  key: RepoView;
  selected: boolean;
  name: string;
  meta: string;
  lead: { kind: "number"; text: string };
}

export function buildRepoViewItems(
  current: RepoView,
  t: (key: string) => string,
): RepoViewItem[] {
  return REPO_VIEWS.map(({ key, number }) => ({
    key,
    selected: key === current,
    name: t(`views.${key}.name`),
    meta: t(`views.${key}.meta`),
    lead: { kind: "number" as const, text: number },
  }));
}
