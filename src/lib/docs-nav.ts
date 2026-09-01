import type { Locale } from "@/i18n/locales";
import { resolveDoc, type DocsRegistry } from "@/lib/docs-registry";

/**
 * 文档目录顺序与当前项（文档中心批 2）。批 3 落地文档时按这个顺序摆放；
 * 批 2 只有 quickstart 一篇，其余 9 个在注册表里都不存在，buildDocsNav
 * 必须正常跳过它们、不能因为"顺序表里有但文件不存在"而报错或渲染空洞。
 */
export const DOCS_ORDER: readonly string[] = [
  "quickstart",
  "deployment",
  "nginx",
  "models",
  "downloads",
  "files",
  "monitoring",
  "inference",
  "settings",
  "troubleshooting",
];

export interface DocsNavItem {
  slug: string;
  title: string;
  current: boolean;
  fallback: boolean;
}

/**
 * 注册表 → 导航项数组：按 DOCS_ORDER 排序（表里没有的 slug 落在末尾按字母
 * 序），标题/回退态经 resolveDoc 按当前语言解析。numbering / href 等
 * SecondaryNav 展示细节留给调用页面组装（同 lib/logs-tabs.ts 只给
 * { key, number }、页面自己拼 name/meta/lead 的分工）。
 */
export function buildDocsNav(registry: DocsRegistry, lang: Locale, currentSlug: string | null): DocsNavItem[] {
  const known = new Set(Object.keys(registry));
  const extras = [...known].filter((slug) => !DOCS_ORDER.includes(slug)).sort((a, b) => a.localeCompare(b));
  const ordered = [...DOCS_ORDER.filter((slug) => known.has(slug)), ...extras];

  return ordered.flatMap((slug) => {
    const resolved = resolveDoc(registry, slug, lang);
    // ordered 只包含 known（即注册表里确实存在的 slug），resolveDoc 理论上
    // 不会在这里返回 null；仍用 flatMap 兜底跳过而不是断言，避免这条不变式
    // 一旦被后续改动打破就直接抛异常炸掉整页导航
    if (!resolved) return [];
    return [
      {
        slug,
        title: resolved.entry.title,
        current: slug === currentSlug,
        fallback: resolved.fallback,
      },
    ];
  });
}
