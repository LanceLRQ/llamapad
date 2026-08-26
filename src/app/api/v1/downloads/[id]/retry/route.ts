import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getDownloadManager } from "@/server/locators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/downloads/:id/retry（UX P1 U25）：失败/取消的任务原地重试
 * （行回 pending，.part 在则续传），替代此前「按模型重下单文件」的整任务重试。
 * - 404：任务不存在
 * - 409：任务状态不可重试（completed 想再下走重新入队；paused 走 resume）
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const { id } = await ctx.params;
  try {
    await getDownloadManager().retry(Number(id));
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("任务不存在")) {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    if (message.includes("仅失败或已取消的任务可重试")) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
