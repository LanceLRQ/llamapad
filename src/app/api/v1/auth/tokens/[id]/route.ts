import { NextResponse } from "next/server";
import { requireAuth, revokeApiToken } from "@/server/auth";
import { getDb } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DELETE /api/v1/auth/tokens/:id：吊销一个 API token（M5）。
 * 仅接受 session（allowBearer:false）——与签发同款，防持有泄漏 token 者互相吊销制造拒绝服务。
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const db = getDb();
  const auth = await requireAuth(req, db, { allowBearer: false });
  if (auth instanceof Response) return auth;

  const { id } = await ctx.params;
  const numeric = Number(id);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return NextResponse.json({ error: "无效的 token id" }, { status: 400 });
  }
  if (!revokeApiToken(db, numeric)) {
    return NextResponse.json({ error: "token 不存在，可能已被吊销" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
