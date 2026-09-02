/**
 * README 内链改写（HF README 视图）
 *
 * README 是在 huggingface.co/<repo> 那个页面渲染的，里面的相对路径全按那个位置解析。
 * 原样搬进面板，图片会 404、链接会把面板导航到一个不存在的路由——**根相对路径尤其危险**，
 * `/Qwen/Qwen3` 留着不动会让面板自己跳到 `/Qwen/Qwen3`。
 *
 * 图片与链接的基址不同：图片要原始字节走 `resolve/main`，链接要网页走 `blob/main`。
 * 用同一个基址会得到一张打不开的图或一个下载而不是打开的链接。
 */

export interface ReadmeUrlContext {
  /** owner/name */
  repo: string;
  /** HF 端点（官方或镜像），可带尾部斜杠 */
  endpoint: string;
  kind: "image" | "link";
}

/** 已经能自己站住的 href：协议开头一律不动 */
const ABSOLUTE = /^(https?:|data:|mailto:|blob:)/i;

/**
 * 返回改写后的绝对地址；返回 null 表示「面板内没有对应目标」，调用方应渲染成
 * 无 href 的纯文本（纯锚点就是这种情况——正文被剥过 frontmatter、又没有 TOC，
 * 锚点跳不到任何地方）。
 */
export function resolveReadmeUrl(
  href: string | undefined,
  ctx: ReadmeUrlContext,
): string | null {
  const raw = href?.trim() ?? "";
  if (raw === "" || raw.startsWith("#")) return null;
  if (ABSOLUTE.test(raw)) return raw;

  const base = ctx.endpoint.replace(/\/+$/, "");
  if (raw.startsWith("/")) return `${base}${raw}`;

  const path = raw.replace(/^\.\//, "");
  const segment = ctx.kind === "image" ? "resolve" : "blob";
  return `${base}/${ctx.repo}/${segment}/main/${path}`;
}
