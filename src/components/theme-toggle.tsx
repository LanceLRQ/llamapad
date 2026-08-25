"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";

const CYCLE = ["light", "dark", "system"] as const;
type CycleTheme = (typeof CYCLE)[number];

/** useSyncExternalStore 的订阅位：客户端标记永不变化，无需真实订阅 */
const subscribeNoop = (): (() => void) => () => {};

export function ThemeToggle() {
  const t = useTranslations("topbar");
  const { theme, setTheme } = useTheme();
  // 是否已在客户端：服务端快照恒 false、客户端恒 true，用于避开主题的 SSR 水合不匹配
  // （服务端无法得知实际主题）。不用 useEffect+setState——那会触发 set-state-in-effect
  const mounted = useSyncExternalStore(subscribeNoop, () => true, () => false);

  if (!mounted) {
    // 占位，避免 SSR 水合不匹配（服务端无法得知实际主题）
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

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={
        current === "light"
          ? t("themeToDark")
          : current === "dark"
            ? t("themeToSystem")
            : t("themeToLight")
      }
      onClick={() => setTheme(next)}
    >
      {current === "light" && <Sun />}
      {current === "dark" && <Moon />}
      {current === "system" && <Monitor />}
    </Button>
  );
}
