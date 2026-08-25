"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Languages } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { locales, type Locale } from "@/i18n/locales";
import { apiFetch } from "@/lib/api";

/**
 * 顶栏语言切换（M0 Task 9）：zh ⇄ en 二态循环。
 *
 * 语义：POST /api/v1/settings/locale（requireAuth 保护）→ 服务端 Set-Cookie
 * `llamapad_locale` 并把偏好写入 settings 表 → router.refresh() 让服务端组件
 * 以新 locale 重渲染。cookie 决定本浏览器语言，settings.locale 是面板级记忆。
 * 未登录界面（登录页）不渲染本组件，语言跟随既有 cookie。
 */
export function LocaleToggle() {
  const t = useTranslations("common");
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
