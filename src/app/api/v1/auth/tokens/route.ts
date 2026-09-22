import { NextResponse } from "next/server";
import { issueApiToken, listApiTokens, requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { recordEvent } from "@/server/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/auth/tokens：列出已签发的 token（不回明文，只给尾 4 位供对照）。仅 session。 */
export async function GET(req: Request): Promise<Response> {
  const db = getDb();
  const auth = await requireAuth(req, db, { allowBearer: false });
  if (auth instanceof Response) return auth;
  return NextResponse.json({ tokens: listApiTokens(db) });
}

/**
 * POST /api/v1/auth/tokens  body { name?, storePlain? }：签发 API token。
 * 仅接受 session（allowBearer:false）——防止持有泄漏 token 者用它自我续命（token 生 token）。
 * 明文 token 只在本次响应出现一次；storePlain 严格等于 true 才把明文一并存进
 * api_tokens.token_plain（换取设置页可反复查看/复制），缺省或任何非 true 的值都按
 * false 处理——安全默认，不存明文时之后只能吊销重发，库里只留 sha256 哈希。
 */
export async function POST(req: Request): Promise<Response> {
  const db = getDb();
  const auth = await requireAuth(req, db, { allowBearer: false });
  if (auth instanceof Response) return auth;

  const body = (await req.json().catch(() => null)) as { name?: unknown; storePlain?: unknown } | null;
  const name =
    typeof body?.name === "string" && body.name.trim().length > 0 ? body.name.trim() : null;
  const storePlain = body?.storePlain === true;

  const token = issueApiToken(db, name, { storePlain });
  recordEvent(db, "auth.token_issue", `签发 API Token「${name ?? "未命名"}」`);
  return NextResponse.json({ token, name }, { status: 201 });
}
