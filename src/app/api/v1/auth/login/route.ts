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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/auth/login  body { password }
 * 验证通过签发 7 天 session 并 Set-Cookie。
 *
 * Cookie 属性说明：HttpOnly 防 JS 读取、Path=/ 全站、SameSite=Lax 防跨站携带；
 * 不加 Secure 是刻意的——dev 环境跑 http，加了 cookie 不会被发送；
 * 生产 HTTPS 反代部署时再补 Secure（T10 部署项）。
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
    `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_SEC}`,
  );
  return res;
}
