/**
 * i18n 公共常量与工具（M0 Task 9）
 *
 * 模式说明：面板不用 next-intl 的路由段方案（不用 middleware / [locale] 段）——
 * 面板整体在登录墙后、无 SEO 需求，且项目架构决策禁用 middleware（Edge Runtime 限制）。
 * 故采用 next-intl「无路由（cookie）」模式：
 * - 当前 locale 由 cookie `llamapad_locale` 决定（未设/非法值回退 zh）
 * - 服务端在 src/i18n/request.ts 读 cookie 组装 messages
 * - 面板级偏好另存 settings 表 key=locale（仅作记忆，渲染只看 cookie）
 */

/** locale cookie 名（与 session cookie 同前缀命名） */
export const LOCALE_COOKIE = "llamapad_locale";

/** 支持的 locale（zh 为默认） */
export const locales = ["zh", "en"] as const;

export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "zh";

/** settings 表中面板级语言偏好的键 */
export const LOCALE_SETTING_KEY = "locale";

/** cookie / 库值的有效性检查（ narrowing 用） */
export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (locales as readonly string[]).includes(value);
}

/** 任意输入 → 合法 locale（非法/缺省回退默认 zh） */
export function resolveLocale(value: unknown): Locale {
  return isLocale(value) ? value : defaultLocale;
}
