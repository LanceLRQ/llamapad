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

/** 有 scheme 前缀，自称是绝对地址——具体放不放行由下面按 kind 分的白名单决定，
 *  这条只用来判断「要不要走相对路径拼接」 */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * 按 `kind` 收紧的放行表。README 是不可信的外部输入，这里比 react-markdown
 * 自带的 `defaultUrlTransform`（http/https/irc/ircs/mailto/xmpp）还要窄——本项目
 * 用不到 irc/xmpp，够用就不多开口子。传 `urlTransform` 会整体替换掉那份默认
 * 实现，放宽了什么就都是这里的责任，不能指望库兜底。
 *
 * `blob:` 一律不放行：README 静态内容里出现 `blob:` 要么是抓取残留、要么是
 * 恶意构造，正常渲染路径不会产出这种 href。
 */
const LINK_ALLOWED = /^(https?:|mailto:)/i;
/** 图片额外放行 data:image/ ——README 偶有内联 base64 小图标；data:text/html 等
 *  非图片 MIME 一律拒绝，不放行裸 `data:` */
const IMAGE_ALLOWED = /^(https?:|data:image\/)/i;

/**
 * 返回改写后的绝对地址；返回 null 表示「面板内没有对应目标」，调用方应渲染成
 * 无 href 的纯文本（纯锚点就是这种情况——正文被剥过 frontmatter、又没有 TOC，
 * 锚点跳不到任何地方；scheme 不在白名单内的绝对地址同样归为这一类，而不是
 * 拼接出一条以假乱真的相对路径 URL）。
 */
export function resolveReadmeUrl(
  href: string | undefined,
  ctx: ReadmeUrlContext,
): string | null {
  const raw = href?.trim() ?? "";
  if (raw === "" || raw.startsWith("#")) return null;

  if (HAS_SCHEME.test(raw)) {
    const allowed = ctx.kind === "image" ? IMAGE_ALLOWED : LINK_ALLOWED;
    return allowed.test(raw) ? raw : null;
  }

  const base = ctx.endpoint.replace(/\/+$/, "");
  if (raw.startsWith("/")) return `${base}${raw}`;

  const path = raw.replace(/^\.\//, "");
  const segment = ctx.kind === "image" ? "resolve" : "blob";
  return `${base}/${ctx.repo}/${segment}/main/${path}`;
}
