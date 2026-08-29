"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Languages } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { locales, type Locale } from "@/i18n/locales";
import { apiFetch } from "@/lib/api";
import { STATUS_BAR_ITEM_CLASS } from "@/lib/status-bar";
import { cn } from "@/lib/utils";

/**
 * 语言切换（M16 T1 补 compact）：zh ⇄ en 二态循环，切换逻辑不因形态而变。
 *
 * 语义：POST /api/v1/settings/locale（requireAuth 保护）→ 服务端 Set-Cookie
 * `llamapad_locale` 并把偏好写入 settings 表 → router.refresh() 让服务端组件
 * 以新 locale 重渲染。cookie 决定本浏览器语言，settings.locale 是面板级记忆。
 * 未登录界面（登录页）不渲染本组件，语言跟随既有 cookie。
 *
 * `compact` 时渲染状态栏条目（图标 + 当前语言文案 statusbar.localeLabel——
 * 该键在 zh.json/en.json 里的取值本身就是"当前语言"的名字，不需要按 locale
 * 再判断一次），供 status-bar-client 使用；默认渲染 icon Button（其他场景）。
 */
export function LocaleToggle({ compact = false }: { compact?: boolean } = {}) {
  const t = useTranslations("common");
  const tStatusbar = useTranslations("statusbar");
  const current = useLocale() as Locale;
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const next: Locale = current === "zh" ? "en" : "zh";
  // 防御：useLocale 若返回非预期值（理论上不会），仍指向合法 locale
  const target = (locales as readonly string[]).includes(next) ? next : "en";

  async function handleToggle() {
    setPending(true);
    try {
      await apiFetch("/api/v1/settings/locale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: target }),
      });
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  if (compact) {
    return (
      <button
        type="button"
        onClick={handleToggle}
        disabled={pending}
        aria-label={t("languageToggle")}
        className={cn(
          STATUS_BAR_ITEM_CLASS,
          "gap-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50",
        )}
      >
        <Languages className="size-3" />
        {tStatusbar("localeLabel")}
      </button>
    );
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={t("languageToggle")}
      onClick={handleToggle}
      disabled={pending}
    >
      <Languages />
    </Button>
  );
}
