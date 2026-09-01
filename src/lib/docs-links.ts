/**
 * 文档正文里链接 / 图片路径的重写判定（文档中心批 2）。纯字符串判定，
 * 不做任何 fs 校验——结果指向的 slug 是否真的存在于注册表由调用方
 * （docs-markdown.tsx 渲染 <Link> 前，或后续批次的死链检查）负责，
 * 这里只管"这段 href/src 该怎么改写"。
 */

export type DocLinkResult =
  /** 站内文档链接，已重写成 /docs/<slug>[#锚点] */
  | { kind: "doc"; href: string }
  /** http(s)/mailto/data，原样返回，调用方需加 target="_blank" */
  | { kind: "external"; href: string }
  /** 纯锚点 / 越出文档根 / 非 .md 的相对链接，原样返回，不瞎猜 */
  | { kind: "raw"; href: string };

const EXTERNAL_PREFIX = /^(https?:|mailto:|data:)/i;

/**
 * `.md` 相对链接 → `/docs/<slug>`；锚点原样保留且不参与 slug 匹配；
 * 查询串直接剥离（文档路由不消费任何 query）；外链原样返回并标记；
 * 越出文档根的 `../` 与非 .md 链接一律原样返回，不试图猜测目标。
 */
export function rewriteDocLink(href: string): DocLinkResult {
  if (EXTERNAL_PREFIX.test(href)) {
    return { kind: "external", href };
  }

  const hashIndex = href.indexOf("#");
  const beforeHash = hashIndex === -1 ? href : href.slice(0, hashIndex);
  const anchor = hashIndex === -1 ? "" : href.slice(hashIndex); // 含 "#" 本身

  // 纯锚点（同页跳转）：没有路径部分，不是文档链接，原样返回
  if (beforeHash === "") {
    return { kind: "raw", href };
  }

  // 越出文档根：不瞎猜，整段 href 原样返回（含查询串/锚点，不做任何裁剪）
  if (beforeHash.startsWith("../")) {
    return { kind: "raw", href };
  }

  const queryIndex = beforeHash.indexOf("?");
  const pathPart = queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex);

  if (!pathPart.endsWith(".md")) {
    return { kind: "raw", href };
  }

  const withoutDotSlash = pathPart.startsWith("./") ? pathPart.slice(2) : pathPart;
  const slugPath = withoutDotSlash.slice(0, -".md".length);
  return { kind: "doc", href: `/docs/${slugPath}${anchor}` };
}

const IMAGES_PREFIX = "images/";

/** `images/xxx.png`（可选 `./` 前缀）→ `/docs-media/xxx.png`；其余原样返回。
 * 提供图片服务的路由是批 4 的事，这里只做路径判定。 */
export function rewriteDocImageSrc(src: string): string {
  if (EXTERNAL_PREFIX.test(src)) return src;

  const withoutDotSlash = src.startsWith("./") ? src.slice(2) : src;
  if (!withoutDotSlash.startsWith(IMAGES_PREFIX)) return src;

  return `/docs-media/${withoutDotSlash.slice(IMAGES_PREFIX.length)}`;
}
