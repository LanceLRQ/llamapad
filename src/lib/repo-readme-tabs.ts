/**
 * 档案详情页「README / 文件」两视图的判定（HF README 视图）
 *
 * 模型模块入口按 pathname 判定；当前仓库的内容页签按 `?view=` 判定，
 * 在内容区顶部展示，不与二级导航混排。
 */

export type RepoView = "readme" | "files";

/** settings 表里记「下次直接进文件列表」的键；写入走 PUT /api/v1/settings/:key */
export const REPO_README_LANDING_KEY = "repo_readme_landing";

export const REPO_VIEWS: readonly RepoView[] = ["readme", "files"];

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

export interface RepoViewItem {
  key: RepoView;
  name: string;
  meta: string;
}

export function buildRepoViewItems(
  t: (key: string) => string,
): RepoViewItem[] {
  return REPO_VIEWS.map((key) => ({
    key,
    name: t(`views.${key}.name`),
    meta: t(`views.${key}.meta`),
  }));
}
