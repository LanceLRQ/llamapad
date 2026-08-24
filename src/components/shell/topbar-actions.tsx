"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { useTranslations } from "next-intl";

import { LocaleToggle } from "@/components/locale-toggle";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * 顶栏右侧交互区（client）：主题切换 · 语言切换 · 头像菜单（登出）。
 * 从 topbar.tsx 拆出——topbar 升为 server 组件接管运行状态 chip（M1 Task 9），
 * 交互部分原样内聚在此，行为不变。
 */
export function TopbarActions() {
  const t = useTranslations("topbar");
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await fetch("/api/v1/auth/logout", { method: "POST" });
    } finally {
      // 无论清 cookie 是否成功都回登录页（session 校验在 (panel)/layout 兜底）
      router.push("/login");
      router.refresh();
    }
  }

  return (
    <>
      <ThemeToggle />
      <LocaleToggle />

      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t("adminMenu")}
          className="flex size-8 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary outline-none transition-colors hover:bg-primary/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          L
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-36">
          <DropdownMenuLabel>{t("admin")}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleLogout} disabled={loggingOut}>
            <LogOut />
            {t("logout")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
