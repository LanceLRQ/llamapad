import type { Locale } from "@/i18n/locales";
import { resolveDoc, type DocsRegistry } from "@/lib/docs-registry";

/**
 * 文档目录的分组与顺序。
 *
 * 分组而非一路编号到底：文档没有固定阅读顺序，读者是带着「我现在要做什么」
 * 来查的，01–10 的连续编号会暗示一条并不存在的阅读路径。分组按任务切，
 * 组内顺序是「同一件事里由浅入深」，不是步骤。
 *
 * 前导位因此用图标而非编号（见 components/shell/secondary-nav.tsx 的取舍说明：
 * 编号留给固定有序集合），图标沿用各功能页在侧栏用的那一个，让文档和它讲的
 * 那个页面能对上号。
 */

export type DocsSectionKey = "start" | "deploy" | "use" | "operate" | "api";

export const DOCS_SECTIONS: readonly { key: DocsSectionKey; slugs: readonly string[] }[] = [
  { key: "start", slugs: ["quickstart"] },
  { key: "deploy", slugs: ["deployment", "nginx"] },
  { key: "use", slugs: ["models", "downloads", "files", "settings"] },
  { key: "operate", slugs: ["monitoring", "troubleshooting"] },
  { key: "api", slugs: ["inference"] },
];

/** 扁平顺序（/docs 入口取首篇、排序判定都用它，不必自己摊平分组表） */
export const DOCS_ORDER: readonly string[] = DOCS_SECTIONS.flatMap((section) => section.slugs);

export interface DocsNavItem {
  slug: string;
  title: string;
  current: boolean;
  fallback: boolean;
  /** 所属分组；不在分组表里的篇目（新加了文件但还没归类）为 null */
  section: DocsSectionKey | null;
}

/**
 * 注册表 → 导航项数组：按 DOCS_SECTIONS 排序（表里没有的 slug 落在末尾按字母
 * 序，section 为 null），标题/回退态经 resolveDoc 按当前语言解析。图标 / href /
 * 分组标签等 SecondaryNav 展示细节留给调用页面组装（同 lib/logs-tabs.ts 只给
 * { key, number }、页面自己拼 name/meta/lead 的分工）。
 */
export function buildDocsNav(registry: DocsRegistry, lang: Locale, currentSlug: string | null): DocsNavItem[] {
  const known = new Set(Object.keys(registry));
  const sectionOf = new Map<string, DocsSectionKey>();
  for (const section of DOCS_SECTIONS) {
    for (const slug of section.slugs) sectionOf.set(slug, section.key);
  }

  const extras = [...known].filter((slug) => !sectionOf.has(slug)).sort((a, b) => a.localeCompare(b));
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
        section: sectionOf.get(slug) ?? null,
      },
    ];
  });
}

/**
 * 分组分隔线的落点：每个「实际有篇目」的分组，取它的首篇 slug。
 * 空分组（该组的文档都还没写）不产出分隔线，否则会出现一条标题下面空无一物。
 * 未归类篇目（section 为 null）也单独起一组，让它们在目录里可见而不是混进上一组。
 */
export function buildDocsNavGroups(
  items: readonly DocsNavItem[],
): { beforeKey: string; section: DocsSectionKey | null }[] {
  const groups: { beforeKey: string; section: DocsSectionKey | null }[] = [];
  let previous: DocsSectionKey | null | undefined;
  for (const item of items) {
    if (item.section !== previous) {
      groups.push({ beforeKey: item.slug, section: item.section });
      previous = item.section;
    }
  }
  return groups;
}
