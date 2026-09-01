import type { Locale } from "@/i18n/locales";

/**
 * 文档注册表装配与语言配对（文档中心批 2）。本文件不碰 fs——扫描 fs 是
 * server/docs.ts 的事，这里只吃「已扫描到的文档描述」纯数据，负责把它们
 * 按 slug（文件名去掉 .md）分组、按语言配对，供页面路由查询。
 */

/** fs 扫描出的单篇文档原始数据：文件名 + 正文首个 h1（没有则 null） */
export interface ScannedDoc {
  lang: Locale;
  /** 文件名，含扩展名，如 "quickstart.md" */
  file: string;
  /** 正文首个 "# " 标题；没有 h1 时为 null，装配时用 slug 兜底标题 */
  firstHeading: string | null;
}

/** 注册表中的一篇文档：slug 是路由段，title 是展示文案 */
export interface DocEntry {
  slug: string;
  lang: Locale;
  file: string;
  title: string;
}

/** slug → 该语言存在则挂对应 DocEntry，两侧都存在时 zh/en 都有值 */
export type DocsRegistry = Record<string, Partial<Record<Locale, DocEntry>>>;

function slugFromFile(file: string): string {
  return file.endsWith(".md") ? file.slice(0, -".md".length) : file;
}

/** 已扫描文档数组 → slug → { zh?, en? } 的注册表 */
export function buildDocsRegistry(scanned: readonly ScannedDoc[]): DocsRegistry {
  const registry: DocsRegistry = {};
  for (const doc of scanned) {
    const slug = slugFromFile(doc.file);
    const entry: DocEntry = {
      slug,
      lang: doc.lang,
      file: doc.file,
      title: doc.firstHeading ?? slug,
    };
    (registry[slug] ??= {})[doc.lang] = entry;
  }
  return registry;
}

function otherLocale(lang: Locale): Locale {
  return lang === "zh" ? "en" : "zh";
}

export interface ResolvedDoc {
  entry: DocEntry;
  /** 命中的不是请求语言而是回退语言——调用方据此在页面上给出提示 */
  fallback: boolean;
}

/**
 * 按 slug + 期望语言解析一篇文档：命中即返回；该语言缺失时回退另一语言并
 * 标记 fallback: true；两种语言都没有该 slug 返回 null。
 */
export function resolveDoc(registry: DocsRegistry, slug: string, lang: Locale): ResolvedDoc | null {
  const pair = registry[slug];
  if (!pair) return null;

  const hit = pair[lang];
  if (hit) return { entry: hit, fallback: false };

  const fallback = pair[otherLocale(lang)];
  if (fallback) return { entry: fallback, fallback: true };

  return null;
}

export interface DocsSlugAsymmetry {
  zhOnly: string[];
  enOnly: string[];
}

/**
 * 两侧 slug 集合的差集——批 3 中英文档对称性检查的地基，本批只提供函数
 * + 测试，不接 CI。
 */
export function findSlugAsymmetry(registry: DocsRegistry): DocsSlugAsymmetry {
  const zhOnly: string[] = [];
  const enOnly: string[] = [];
  for (const [slug, pair] of Object.entries(registry)) {
    const hasZh = pair.zh !== undefined;
    const hasEn = pair.en !== undefined;
    if (hasZh && !hasEn) zhOnly.push(slug);
    if (hasEn && !hasZh) enOnly.push(slug);
  }
  zhOnly.sort((a, b) => a.localeCompare(b));
  enOnly.sort((a, b) => a.localeCompare(b));
  return { zhOnly, enOnly };
}
