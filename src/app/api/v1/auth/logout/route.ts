import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/v1/auth/logout：清 cookie（Max-Age=0 立即过期）。
 *  session 是无状态 HMAC token，客户端清 cookie 即完成登出；服务端吊销需轮换 secret（见 auth.ts 注释）。 */
export async function POST(): Promise<Response> {
  const res = NextResponse.json({ ok: true });
  res.headers.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`,
  );
  return res;
}
