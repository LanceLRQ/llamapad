import { notFound } from "next/navigation";
import { BookOpen } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { DocsMarkdown } from "@/components/docs-markdown";
import { PageHeader } from "@/components/shell/page-header";
import { resolveLocale } from "@/i18n/locales";
import { stripLeadingHeading } from "@/lib/docs-content";
import { buildDocsNav, buildDocsNavGroups } from "@/lib/docs-nav";
import { resolveDoc } from "@/lib/docs-registry";
import { getDocBody, getDocsRegistry, getDocsRoot } from "@/server/docs";
import { DocsNav } from "../docs-nav";

// 读 fs（扫描/读取 docs/guide）→ 全动态渲染，与 (panel) 组其余页面一致
export const dynamic = "force-dynamic";

/**
 * 文档正文页：布局照抄 logs/page.tsx 的三段结构（负边距贴边 + 二级栏 +
 * PageHeader + 内容区），差异在二级栏是按任务分组的文档目录（分组与顺序见
 * lib/docs-nav.ts），且走 href 真跳转而不是 ?tab= query 切换。
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

  // 跨到 client 侧的只有可序列化数据：图标表在 DocsNav 里按 slug 查
  // （server 组件不能把 React 组件当 prop 传给 client 组件）。分组标签在这边
  // 按当前语言取好再传，client 侧不碰 i18n
  const navItems = nav.map((item) => ({
    slug: item.slug,
    title: item.title,
    selected: item.current,
  }));

  const navGroups = buildDocsNavGroups(nav).map(({ beforeKey, section }) => ({
    beforeKey,
    label: section === null ? t("sections.other") : t(`sections.${section}`),
  }));

  return (
    // 二级栏必须贴到应用外壳的框边：main 留了 px-[34px] pt-7 pb-12，本页
    // 用负边距抵消（T1→T11 迁移期的过渡做法，对齐 logs/models 等页）。
    // 正文区必须 min-h-0 flex-1 overflow-y-auto——这里曾在别的空态分支上
    // 漏加过，滚动区域直接失效，此处照抄不能再漏
    <div className="-mx-[34px] -mt-7 -mb-12 flex h-[calc(100%+76px)] min-h-96">
      <DocsNav title={t("title")} items={navItems} groups={navGroups} current={slug} />
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
