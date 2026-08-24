"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Monitor, Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";

const CYCLE = ["light", "dark", "system"] as const;
type CycleTheme = (typeof CYCLE)[number];

const NEXT_LABEL: Record<CycleTheme, string> = {
  light: "切换到暗色主题",
  dark: "切换到跟随系统主题",
  system: "切换到亮色主题",
};

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    // 占位，避免 SSR 水合不匹配（服务端无法得知实际主题）
    return (
      <Button variant="ghost" size="icon" aria-label="切换主题" disabled>
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
      aria-label={NEXT_LABEL[current]}
      onClick={() => setTheme(next)}
    >
      {current === "light" && <Sun />}
      {current === "dark" && <Moon />}
      {current === "system" && <Monitor />}
    </Button>
  );
}
