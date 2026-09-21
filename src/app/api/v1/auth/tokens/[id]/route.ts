import { NextResponse } from "next/server";
import { getApiTokenPlain, requireAuth, revokeApiToken } from "@/server/auth";
import { getDb } from "@/server/db";
import { recordEvent } from "@/server/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/auth/tokens/:id：取回某个 token 的明文，供设置页展开查看/复制。
 * 仅接受 session（allowBearer:false）——与签发/吊销同款，防止持有某个泄漏 token 的程序
 * 借这个接口把其余全部密钥读出来。
 * 不记事件：查看是高频只读操作，展开一次记一条会把 events 表刷爆。
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const db = getDb();
  const auth = await requireAuth(req, db, { allowBearer: false });
  if (auth instanceof Response) return auth;

  const { id } = await ctx.params;
  const numeric = Number(id);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return NextResponse.json({ error: "无效的 token id" }, { status: 400 });
  }
  const token = getApiTokenPlain(db, numeric);
  if (token === null) {
    return NextResponse.json({ error: "token 不存在或明文不可查看" }, { status: 404 });
  }
  return NextResponse.json({ token });
}

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
  recordEvent(db, "auth.token_revoke", `吊销 API Token #${numeric}`);
  return NextResponse.json({ ok: true });
}
