"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { useTranslations } from "next-intl";

import { LocaleToggle } from "@/components/locale-toggle";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * 应用壳顶栏（M0）。
 * 左侧页面标题（M0 固定 "llamapad"，M1 起由各页元信息驱动）；
 * 右侧：运行状态 chip 占位（M3 接真实状态）· 主题切换 · 语言切换 · 头像菜单（登出）。
 */

export function Topbar() {
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
    <header className="sticky top-0 z-10 flex h-[58px] flex-none items-center gap-3.5 border-b bg-background/80 px-[34px] backdrop-blur">
      <h1 className="text-base font-semibold tracking-tight">llamapad</h1>

      <div className="flex-1" />

      {/* 运行状态 chip 占位：M0 无推理服务，固定灰色"未运行"（M3 接运行态 + 呼吸点） */}
      <Badge variant="outline" className="gap-1.5 text-xs text-muted-foreground">
        <span className="size-1.5 rounded-full bg-muted-foreground/50" />
        {t("statusIdle")}
      </Badge>

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
    </header>
  );
}
