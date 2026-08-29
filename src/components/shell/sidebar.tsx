"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  Box,
  Download,
  Folder,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Settings,
} from "lucide-react";
import { useTranslations } from "next-intl";

import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * 应用壳侧栏（M0；M16 T1 归并顶栏品牌/登出）。
 *
 * 导航项名称 / 图标 / 顺序对照 ui-demo/overview.html：
 * 概览 LayoutDashboard · 模型 Box · 下载 Download · 文件 Folder · 监控 Activity ·
 * Chat MessageSquare ·（分组"系统"）设置 Settings。
 *
 * 当前项高亮取舍：侧栏是纯静态导航（无服务端数据），做成客户端组件用
 * usePathname() 判断的开销可忽略（约 1KB JS），且能获得预取跳转时的即时高亮；
 * server 端判断 pathname 需要读请求头（Next 无公开 API）或每页向 layout 传 prop，
 * 都比这一小段客户端边界更贵，故取前者。
 *
 * M16 T1：原顶栏的品牌名与登出各归其位——品牌行右侧补版本号（NEXT_PUBLIC_APP_VERSION，
 * 经 next.config.ts 从 package.json 注入，client 组件不便直接 import JSON 进 bundle）；
 * 底部新增 foot 区（头像圆点 + "admin" + 登出按钮），登出流程原样从
 * 旧顶栏交互区迁入（POST 登出 → 跳登录页 → refresh，不因迁移改行为）。
 */

interface NavItem {
  href: string;
  /** messages nav.* 下的文案键（i18n，M0 Task 9） */
  labelKey:
    | "overview"
    | "models"
    | "downloads"
    | "files"
    | "monitoring"
    | "chat"
    | "settings";
  icon: typeof LayoutDashboard;
}

const NAV_MAIN: NavItem[] = [
  { href: "/", labelKey: "overview", icon: LayoutDashboard },
  { href: "/models", labelKey: "models", icon: Box },
  { href: "/downloads", labelKey: "downloads", icon: Download },
  { href: "/files", labelKey: "files", icon: Folder },
  { href: "/monitoring", labelKey: "monitoring", icon: Activity },
  { href: "/chat", labelKey: "chat", icon: MessageSquare },
];

const NAV_SYSTEM: NavItem[] = [{ href: "/settings", labelKey: "settings", icon: Settings }];

function isActive(pathname: string, href: string): boolean {
  // "/" 精确匹配，其余前缀匹配（为 M1+ 的嵌套子路由留余地）
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

function NavLink({
  item,
  pathname,
  label,
}: {
  item: NavItem;
  pathname: string;
  label: string;
}) {
  const active = isActive(pathname, item.href);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        active &&
          "bg-accent font-semibold text-foreground shadow-[inset_2.5px_0_0_0_var(--primary)]",
      )}
    >
      <Icon className="size-4 shrink-0" />
      {label}
    </Link>
  );
}

export function Sidebar() {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);

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
    <aside className="flex min-h-0 flex-col overflow-y-auto border-r bg-sidebar px-3 py-4">
      {/* 品牌 mark：logo 未设计，沿用 demo 的 amber 渐变方块 + "L" 占位；
          右侧版本号（次要信息，mono + 弱化色，不与品牌名抢视觉权重） */}
      <div className="flex items-center justify-between gap-2 px-2.5 pb-5 pt-1">
        <div className="flex items-center gap-2.5 text-[15px] font-bold">
          <span className="flex size-7 items-center justify-center rounded-lg bg-gradient-to-br from-amber-400 to-amber-500 font-mono text-sm font-extrabold text-stone-900">
            L
          </span>
          llamapad
        </div>
        <span className="font-mono text-[11px] text-muted-foreground">
          v{process.env.NEXT_PUBLIC_APP_VERSION}
        </span>
      </div>

      <nav className="flex flex-col gap-0.5">
        {NAV_MAIN.map((item) => (
          <NavLink key={item.href} item={item} pathname={pathname} label={t(item.labelKey)} />
        ))}
      </nav>

      <div className="mt-auto flex flex-col gap-0.5">
        <div className="px-3 pb-1.5 pt-4 text-[11px] tracking-wider text-muted-foreground/60">
          {t("systemGroup")}
        </div>
        {NAV_SYSTEM.map((item) => (
          <NavLink key={item.href} item={item} pathname={pathname} label={t(item.labelKey)} />
        ))}
      </div>

      {/* foot：管理员身份 + 登出（原顶栏头像菜单，M16 T1 拍平成静态条目——
          侧栏常驻可见，不再需要下拉菜单包一层） */}
      <div className="mt-3 flex items-center gap-2 border-t pt-3">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 font-mono text-[11px] font-semibold text-primary">
          A
        </span>
        <span className="flex-1 truncate text-sm text-foreground">{t("admin")}</span>
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
