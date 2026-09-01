import { notFound, redirect } from "next/navigation";
import { getLocale } from "next-intl/server";

import { resolveLocale } from "@/i18n/locales";
import { buildDocsNav } from "@/lib/docs-nav";
import { getDocsRegistry } from "@/server/docs";

// 读 fs（扫描 docs/guide）→ 全动态渲染，与 (panel) 组其余页面一致
export const dynamic = "force-dynamic";

/**
 * 文档中心入口（文档中心批 2）：本身不渲染任何 UI，只把 /docs 重定向到
 * 目录第一项的 slug（当前批唯一一篇是 quickstart）。docs/guide 目录缺失
 * 或注册表为空时落 404，而不是重定向到一个不存在的页面死循环。
 */
export default async function DocsIndexPage() {
  const locale = resolveLocale(await getLocale());
  const registry = getDocsRegistry();
  const nav = buildDocsNav(registry, locale, null);

  if (nav.length === 0) notFound();
  redirect(`/docs/${nav[0].slug}`);
}
