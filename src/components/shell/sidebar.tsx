"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BookOpen,
  Box,
  Download,
  Folder,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  ScrollText,
  Settings,
} from "lucide-react";
import { useTranslations } from "next-intl";

import { apiFetch } from "@/lib/api";
import { sidebarCollapseStore } from "@/lib/sidebar-collapse";
import { cn } from "@/lib/utils";

/**
 * 应用壳侧栏（M0；M16 T1 归并顶栏品牌/登出）。
 *
 * 导航项名称 / 图标 / 顺序对照 ui-demo/overview.html：
 * 概览 LayoutDashboard · 模型 Box · 下载 Download · 文件 Folder · 日志 ScrollText
 * （原「监控」用 Activity 的脉搏波形，指标那组并进概览、页面改名 /logs 之后
 * 波形已经名不副实，换成日志查看器的常规图标）·
 * Chat MessageSquare · 文档 BookOpen（文档中心批 2 新增，排在 Chat 之后）；
 * 设置 Settings 独立落在底部 foot 区。
 *
 * 当前项高亮取舍：侧栏是纯静态导航（无服务端数据），做成客户端组件用
 * usePathname() 判断的开销可忽略（约 1KB JS），且能获得预取跳转时的即时高亮；
 * server 端判断 pathname 需要读请求头（Next 无公开 API）或每页向 layout 传 prop，
 * 都比这一小段客户端边界更贵，故取前者。
 *
 * M16 T1：原顶栏的品牌名与登出各归其位；底部 foot 区放登出，登出流程原样从旧顶栏
 * 交互区迁入（POST 登出 → 跳登录页 → refresh，不因迁移改行为）。版本号已挪到底部
 * 状态栏最右端（见 status-bar-client.tsx）。foot 原有的头像圆点 + "管理员"是纯占位
 * ——本面板没有用户系统，唯一主体就是 admin，展示它不提供任何信息，已去掉；空出的
 * 位置由设置补上（"系统"分组只有设置一项，整组随之删除，避免设置出现两次）。
 *
 * 折叠态（见 lib/sidebar-collapse.ts）：布局与标签显隐一律由 CSS 的 collapsed
 * 变体驱动，不由 React state 驱动——React 首帧拿不到 localStorage，用 state 控
 * 宽度会让折叠态用户每次刷新先看见 200px 再跳到 60px。React 只负责非视觉属性
 * （按钮的 aria-expanded / aria-label / title），经 useSyncExternalStore 读
 * <html data-sidebar> 属性，首帧值不对也看不见，水合后立刻自校正。
 */

interface NavItem {
  href: string;
  /** messages nav.* 下的文案键（i18n，M0 Task 9） */
  labelKey:
    | "overview"
    | "models"
    | "downloads"
    | "files"
    | "logs"
    | "chat"
    | "docs"
    | "settings";
  icon: typeof LayoutDashboard;
}

const NAV_MAIN: NavItem[] = [
  { href: "/", labelKey: "overview", icon: LayoutDashboard },
  { href: "/models", labelKey: "models", icon: Box },
  { href: "/downloads", labelKey: "downloads", icon: Download },
  { href: "/files", labelKey: "files", icon: Folder },
  { href: "/logs", labelKey: "logs", icon: ScrollText },
  { href: "/chat", labelKey: "chat", icon: MessageSquare },
  { href: "/docs", labelKey: "docs", icon: BookOpen },
];

function isActive(pathname: string, href: string): boolean {
  // "/" 精确匹配，其余前缀匹配（为 M1+ 的嵌套子路由留余地）
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

function NavLink({
  item,
  pathname,
  label,
  collapsed,
}: {
  item: NavItem;
  pathname: string;
  label: string;
  collapsed: boolean;
}) {
  const active = isActive(pathname, item.href);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      title={collapsed ? label : undefined}
      className={cn(
        "flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground collapsed:justify-center collapsed:px-0",
        active &&
          "bg-accent font-semibold text-foreground shadow-[inset_2.5px_0_0_0_var(--primary)]",
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="collapsed:hidden">{label}</span>
    </Link>
  );
}

export function Sidebar() {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);
  const collapsed = useSyncExternalStore(
    sidebarCollapseStore.subscribe,
    sidebarCollapseStore.getSnapshot,
    sidebarCollapseStore.getServerSnapshot,
  );

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await apiFetch("/api/v1/auth/logout", { method: "POST" });
    } finally {
      // 无论清 cookie 是否成功都回登录页（session 校验在 (panel)/layout 兜底）
      router.push("/login");
      router.refresh();
    }
  }

  return (
    // 200px 而不是更早的 236px：这一栏最宽的内容是品牌行（logo 28 + 间距 +
    // "llamapad" + 折叠按钮 28 ≈ 184px），导航项最长的是英文 "Downloads"
    // （≈ 144px），旧的 236px 下每一行右边都空出一大截。留 ~16px 余量给字体差异
    <aside className="flex min-h-0 w-[200px] shrink-0 flex-col overflow-x-hidden overflow-y-auto border-r bg-sidebar px-3 py-4 transition-[width] duration-200 collapsed:w-[60px] collapsed:px-2 motion-reduce:transition-none">
      {/* 品牌行：展开时 [logo + 名] 左、折叠按钮右；折叠时按钮独占居中位，
          logo 转绝对定位盖在同一格上，悬停时淡出让位给按钮。
          单按钮而非两个：两个按钮会多出一个 tab 停靠点，也会把 onClick 抄两遍 */}
      <div className="group/brand relative flex items-center justify-between gap-2 px-2.5 pb-5 pt-1 collapsed:justify-center collapsed:px-0">
        {/* logo 除了悬停，键盘聚焦时也要让位：按钮是绝对定位的 logo 的兄弟，
            logo 会盖在它上面，只淡出按钮等于让键盘用户只看得见一圈焦点环。
            折叠态还必须收掉指针事件：opacity 为 0 的元素照样吃点击，logo 盖在
            按钮上会把「点击展开」整个吞掉——看得见、按不动。折叠时它纯装饰，
            指针事件穿透到底下的按钮，品牌行的 :hover 判定不受影响 */}
        <div className="flex items-center gap-2.5 text-[15px] font-bold transition-opacity collapsed:pointer-events-none collapsed:absolute collapsed:top-1 collapsed:left-1/2 collapsed:-translate-x-1/2 collapsed:group-hover/brand:opacity-0 collapsed:group-has-[:focus-visible]/brand:opacity-0">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-amber-400 to-amber-500 font-mono text-sm font-extrabold text-stone-900">
            L
          </span>
          <span className="collapsed:hidden">llamapad</span>
        </div>
        <button
          type="button"
          onClick={sidebarCollapseStore.toggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t("expandSidebar") : t("collapseSidebar")}
          title={collapsed ? t("expandSidebar") : t("collapseSidebar")}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-[color,background-color,opacity] hover:bg-accent hover:text-foreground collapsed:opacity-0 collapsed:group-hover/brand:opacity-100 collapsed:focus-visible:opacity-100"
        >
          {/* 两个图标由 CSS 二选一，不由 React 判断：首帧 React 还不知道是不是折叠态 */}
          <PanelLeftClose className="size-4 collapsed:hidden" />
          <PanelLeftOpen className="hidden size-4 collapsed:block" />
        </button>
      </div>

      <nav className="flex flex-col gap-0.5">
        {NAV_MAIN.map((item) => (
          <NavLink
            key={item.href}
            item={item}
            pathname={pathname}
            label={t(item.labelKey)}
            collapsed={collapsed}
          />
        ))}
      </nav>

      {/* foot：设置 + 登出。折叠时改竖排居中，设置文案随之隐藏。
          设置刻意不走 NavLink：主导航靠"选中态背景块 + 琥珀指示条"标出当前页，
          那套分量放在 foot 里会让它比旁边的登出重一大截、也不再像一组。这里只留
          悬停反馈，与登出按钮同一分量；当前页仍由 aria-current 传给读屏器 */}
      <div className="mt-auto flex items-center gap-1 border-t pt-3 collapsed:flex-col collapsed:gap-1">
        <Link
          href="/settings"
          aria-current={isActive(pathname, "/settings") ? "page" : undefined}
          title={collapsed ? t("settings") : undefined}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground collapsed:w-full collapsed:flex-none collapsed:justify-center collapsed:px-0"
        >
          <Settings className="size-4 shrink-0" />
          <span className="collapsed:hidden">{t("settings")}</span>
        </Link>
        <button
          type="button"
          onClick={handleLogout}
          disabled={loggingOut}
          aria-label={t("logout")}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <LogOut className="size-4" />
        </button>
      </div>
    </aside>
  );
}
