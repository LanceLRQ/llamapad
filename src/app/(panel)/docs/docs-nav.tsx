"use client";

import {
  Activity,
  BookOpen,
  Box,
  Download,
  Folder,
  LifeBuoy,
  Plug,
  Rocket,
  Server,
  Settings,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

import { SecondaryNav } from "@/components/shell/secondary-nav";

/**
 * 文档目录的二级栏。
 *
 * 单独成一个 client 组件而不是在 [slug]/page.tsx 里直接拼 items：图标前导位要的是
 * React 组件（函数），server 组件不能把函数当 prop 传给 client 组件（SecondaryNav
 * 是 client）。所以跨界传的是 slug 这个字符串，图标表放在这一侧按 slug 查。
 * 其余几个用图标前导位的调用方（模型编辑页等）本身就是 client 组件，没有这层问题。
 *
 * 前导位用图标不用编号：文档没有固定阅读顺序，01–10 的连续编号会暗示一条并不存在
 * 的阅读路径（对照 secondary-nav.tsx 的取舍说明：编号留给固定有序集合）。
 * 图标优先复用该篇讲的那个功能页在侧栏用的那一个（模型 Box、下载 Download、
 * 文件 Folder、日志 Activity、设置 Settings），让读者一眼把文档和页面对上号；
 * 没有对应页面的几篇另选。未归类的新篇目落 BookOpen 兜底，不至于空着一个前导位。
 */
const DOC_ICONS: Record<string, LucideIcon> = {
  quickstart: Rocket,
  deployment: Server,
  nginx: ShieldCheck,
  models: Box,
  downloads: Download,
  files: Folder,
  settings: Settings,
  monitoring: Activity,
  troubleshooting: LifeBuoy,
  inference: Plug,
};

export interface DocsNavProps {
  title: string;
  /** 按目录顺序排好的篇目（server 侧算好，这里不再排序） */
  items: { slug: string; title: string; selected: boolean }[];
  /** 分组分隔线：label 已在 server 侧按当前语言取好 */
  groups: { beforeKey: string; label: string }[];
  current: string;
}

export function DocsNav({ title, items, groups, current }: DocsNavProps) {
  return (
    <SecondaryNav
      kicker="DOCS"
      title={title}
      items={items.map((item) => ({
        key: item.slug,
        href: `/docs/${item.slug}`,
        selected: item.selected,
        name: item.title,
        lead: { kind: "icon" as const, icon: DOC_ICONS[item.slug] ?? BookOpen },
      }))}
      groups={groups}
      queryKey="slug"
      current={current}
    />
  );
}
