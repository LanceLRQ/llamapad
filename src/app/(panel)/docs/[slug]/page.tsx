import { notFound } from "next/navigation";
import { BookOpen } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { DocsMarkdown } from "@/components/docs-markdown";
import { PageHeader } from "@/components/shell/page-header";
import { SecondaryNav } from "@/components/shell/secondary-nav";
import { resolveLocale } from "@/i18n/locales";
import { stripLeadingHeading } from "@/lib/docs-content";
import { buildDocsNav } from "@/lib/docs-nav";
import { resolveDoc } from "@/lib/docs-registry";
import { getDocBody, getDocsRegistry, getDocsRoot } from "@/server/docs";

// 读 fs（扫描/读取 docs/guide）→ 全动态渲染，与 (panel) 组其余页面一致
export const dynamic = "force-dynamic";

/**
 * 文档正文页（文档中心批 2）：布局照抄 logs/page.tsx 的三段结构（负边距
 * 贴边 + SecondaryNav + PageHeader + 内容区），差异只在二级栏条目是固定
 * 有序的文档目录，且走 href 真跳转而不是 ?tab= query 切换。
 *
 * slug 只经 resolveDoc 查注册表，不直接拼文件路径——路径穿越防护在
 * server/docs.ts 那一层（注册表本身只可能收录扫描到的真实文件）。
 */
export default async function DocPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const locale = resolveLocale(await getLocale());
  const t = await getTranslations("pages.docs");

  const registry = getDocsRegistry();
  const resolved = resolveDoc(registry, slug, locale);
  if (!resolved) notFound();

  // 源文件的开头标题（"# 标题"）要保留在磁盘上——GitHub 网页直接查看、
  // extractFirstHeading 取 PageHeader 标题都靠它；但渲染进正文前裁掉它，
  // 否则和上面 PageHeader 的同一个标题重复展示一次
  const body = stripLeadingHeading(getDocBody(getDocsRoot(), resolved.entry));
  const nav = buildDocsNav(registry, locale, slug);

  // 二级栏条目：lib/docs-nav.ts 只给 slug/标题/当前项/回退态四个纯数据字段，
  // 编号（固定有序集合的前导位语义）与 href/selected 这些"怎么展示"的细节
  // 由页面自己拼——同 logs/page.tsx 拿 LOGS_TABS 的 {key, number} 拼 items 一样的分工
  const navItems = nav.map((item, index) => ({
    key: item.slug,
    href: `/docs/${item.slug}`,
    selected: item.current,
    name: item.title,
    lead: { kind: "number" as const, text: String(index + 1).padStart(2, "0") },
  }));

  return (
    // 二级栏必须贴到应用外壳的框边：main 留了 px-[34px] pt-7 pb-12，本页
    // 用负边距抵消（T1→T11 迁移期的过渡做法，对齐 logs/models 等页）。
    // 正文区必须 min-h-0 flex-1 overflow-y-auto——这里曾在别的空态分支上
    // 漏加过，滚动区域直接失效，此处照抄不能再漏
    <div className="-mx-[34px] -mt-7 -mb-12 flex h-[calc(100%+76px)] min-h-96">
      <SecondaryNav kicker="DOCS" title={t("title")} items={navItems} queryKey="slug" current={slug} />
      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader icon={BookOpen} title={resolved.entry.title} />
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-7 py-6">
          {resolved.fallback && (
            <p className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              {t("fallbackNotice", {
                lang: t(locale === "zh" ? "langZh" : "langEn"),
                fallbackLang: t(resolved.entry.lang === "zh" ? "langZh" : "langEn"),
              })}
            </p>
          )}
          <DocsMarkdown text={body} />
        </div>
      </div>
    </div>
  );
}
