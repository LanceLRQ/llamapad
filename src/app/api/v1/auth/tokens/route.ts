import { NextResponse } from "next/server";
import { generateApiToken, hashToken, requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/auth/tokens  body { name? }：签发 API token。
 * 仅接受 session（allowBearer:false）——防止持有泄漏 token 者用它自我续命（token 生 token）。
 * 明文 token 只在本次响应出现一次，库中只存 sha256 哈希。
 */
export async function POST(req: Request): Promise<Response> {
  const db = getDb();
  const auth = await requireAuth(req, db, { allowBearer: false });
  if (auth instanceof Response) return auth;

  const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
  const name =
    typeof body?.name === "string" && body.name.trim().length > 0 ? body.name.trim() : null;

  const token = generateApiToken();
  db.prepare("INSERT INTO api_tokens(token_hash, name, created_at) VALUES (?, ?, ?)").run(
    hashToken(token),
    name,
    Date.now(),
  );
  return NextResponse.json({ token, name }, { status: 201 });
}
