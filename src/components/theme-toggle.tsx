"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { STATUS_BAR_ITEM_CLASS } from "@/lib/status-bar";
import { cn } from "@/lib/utils";

const CYCLE = ["light", "dark", "system"] as const;
type CycleTheme = (typeof CYCLE)[number];

/** useSyncExternalStore 的订阅位：客户端标记永不变化，无需真实订阅 */
const subscribeNoop = (): (() => void) => () => {};

/**
 * 主题切换（M16 T1 补 compact）：亮/暗/跟随系统三态循环，切换逻辑不因形态而变——
 * 默认渲染 icon Button（登录页等非状态栏场景）；`compact` 时渲染状态栏条目
 * （图标 + 当前主题文案），供 status-bar-client 使用。
 */
export function ThemeToggle({ compact = false }: { compact?: boolean } = {}) {
  const t = useTranslations("statusbar");
  const { theme, setTheme } = useTheme();
  // 是否已在客户端：服务端快照恒 false、客户端恒 true，用于避开主题的 SSR 水合不匹配
  // （服务端无法得知实际主题）。不用 useEffect+setState——那会触发 set-state-in-effect
  const mounted = useSyncExternalStore(subscribeNoop, () => true, () => false);

  if (!mounted) {
    // 占位，避免 SSR 水合不匹配（服务端无法得知实际主题）
    if (compact) {
      return (
        <span aria-hidden className={cn(STATUS_BAR_ITEM_CLASS, "gap-1 text-muted-foreground/50")}>
          <Sun className="size-3" />
        </span>
      );
    }
    return (
      <Button variant="ghost" size="icon" aria-label={t("themeToggle")} disabled>
        <Sun />
      </Button>
    );
  }

  const current: CycleTheme = (CYCLE as readonly string[]).includes(theme ?? "")
    ? (theme as CycleTheme)
    : "system";
  const next = CYCLE[(CYCLE.indexOf(current) + 1) % CYCLE.length];
  const ariaLabel =
    current === "light"
      ? t("themeToDark")
      : current === "dark"
        ? t("themeToSystem")
        : t("themeToLight");

  if (compact) {
    const Icon = current === "light" ? Sun : current === "dark" ? Moon : Monitor;
    const label =
      current === "light" ? t("themeLight") : current === "dark" ? t("themeDark") : t("themeSystem");
    return (
      <button
        type="button"
        onClick={() => setTheme(next)}
        aria-label={ariaLabel}
        className={cn(
          STATUS_BAR_ITEM_CLASS,
          "gap-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        )}
      >
        <Icon className="size-3" />
        {label}
      </button>
    );
  }

  return (
    <Button variant="ghost" size="icon" aria-label={ariaLabel} onClick={() => setTheme(next)}>
      {current === "light" && <Sun />}
      {current === "dark" && <Moon />}
      {current === "system" && <Monitor />}
    </Button>
  );
}
