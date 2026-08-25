import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_TTL_SEC,
  createSession,
  ensureAdminFromEnv,
  getOrCreateSessionSecret,
  verifyAdminPassword,
} from "@/server/auth";
import { getDb } from "@/server/db";
import { buildSessionCookie } from "@/server/cookie";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/auth/login  body { password }
 * 验证通过签发 7 天 session 并 Set-Cookie。
 *
 * Cookie 属性说明：HttpOnly 防 JS 读取、Path=/ 全站、SameSite=Lax 防跨站携带；
 * Secure 按请求协议自适应（X-Forwarded-Proto 为 https，或直连本身是 https 时加上），
 * 局域网 HTTP 直连不加——两种部署都能登录，详见 @/server/cookie。
 */
export async function POST(req: Request): Promise<Response> {
  const db = getDb();
  // env 引导兜底：即使登录页未被渲染（如直接 curl），PANEL_ADMIN_PASSWORD 也能完成首启
  await ensureAdminFromEnv(db);

  const body = (await req.json().catch(() => null)) as { password?: unknown } | null;
  const password = body?.password;
  if (typeof password !== "string" || password.length === 0) {
    return NextResponse.json({ error: "password 必须是非空字符串" }, { status: 400 });
  }

  if (!(await verifyAdminPassword(db, password))) {
    return NextResponse.json({ error: "密码错误" }, { status: 401 });
  }

  const secret = getOrCreateSessionSecret(db);
  const token = createSession(secret, SESSION_TTL_SEC);

  const res = NextResponse.json({ ok: true });
  res.headers.append(
    "Set-Cookie",
    buildSessionCookie({
      name: SESSION_COOKIE,
      value: token,
      maxAgeSec: SESSION_TTL_SEC,
      forwardedProto: req.headers.get("x-forwarded-proto"),
      requestUrl: req.url,
    }),
  );
  return res;
}
