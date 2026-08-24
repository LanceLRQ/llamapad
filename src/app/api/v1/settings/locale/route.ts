import { NextResponse } from "next/server";

import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { LOCALE_COOKIE, LOCALE_SETTING_KEY, isLocale, resolveLocale } from "@/i18n/locales";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** locale cookie 有效期：1 年（纯偏好记忆，过期仅回退默认 zh，无安全影响） */
const LOCALE_TTL_SEC = 365 * 24 * 60 * 60;

/**
 * GET /api/v1/settings/locale：返回当前生效 locale（读 cookie，非法回退 zh）
 * 与 settings 表记忆值（未记录为 null）。主要用于联调 / 自检。
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const cookieHeader = req.headers.get("cookie") ?? "";
  const match = new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]*)`).exec(cookieHeader);
  const remembered = getDb()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(LOCALE_SETTING_KEY) as { value: string } | undefined;

  return NextResponse.json({
    locale: resolveLocale(match ? decodeURIComponent(match[1]) : null),
    remembered: isLocale(remembered?.value) ? remembered.value : null,
  });
}

/**
 * POST /api/v1/settings/locale  body { locale: "zh" | "en" }
 * Set-Cookie `llamapad_locale`（决定本浏览器渲染语言）+ 写 settings 表 key=locale
 * （面板级记忆）。前端随后 router.refresh() 以新 locale 重渲染服务端组件。
 */
export async function POST(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const body = (await req.json().catch(() => null)) as { locale?: unknown } | null;
  if (!isLocale(body?.locale)) {
    return NextResponse.json(
      { error: "locale 必须是 zh 或 en" },
      { status: 400 },
    );
  }
  const locale = body.locale;

  getDb()
    .prepare(
      `INSERT INTO settings(key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(LOCALE_SETTING_KEY, locale);

  const res = NextResponse.json({ ok: true, locale });
  // 与 session cookie 同策略：HttpOnly / Path=/ / SameSite=Lax，不加 Secure（dev 跑 http）
  res.headers.append(
    "Set-Cookie",
    `${LOCALE_COOKIE}=${locale}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${LOCALE_TTL_SEC}`,
  );
  return res;
}
