import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/server/auth";
import { getDb } from "@/server/db";
import { recordEvent } from "@/server/events";
import { buildSessionCookie } from "@/server/cookie";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/v1/auth/logout：清 cookie（Max-Age=0 立即过期）。
 *  session 是无状态 HMAC token，客户端清 cookie 即完成登出；服务端吊销需轮换 secret（见 auth.ts 注释）。
 *  清除用的 cookie 属性必须与签发一致（Secure 含否同理），否则浏览器不覆盖旧 cookie。 */
export async function POST(req: Request): Promise<Response> {
  recordEvent(getDb(), "auth.logout", "退出登录");
  const res = NextResponse.json({ ok: true });
  res.headers.append(
    "Set-Cookie",
    buildSessionCookie({
      name: SESSION_COOKIE,
      value: "",
      maxAgeSec: 0,
      forwardedProto: req.headers.get("x-forwarded-proto"),
      requestUrl: req.url,
    }),
  );
  return res;
}
