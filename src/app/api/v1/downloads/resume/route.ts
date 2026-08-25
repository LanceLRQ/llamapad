import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getDownloadManager } from "@/server/locators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/downloads/resume：队列级恢复（M5）。
 *
 * 与 /downloads/:id/resume 的区别——那个是单任务从 paused 回 pending（对 pending 是 no-op），
 * 这个是在「连续失败 3 次停队」后重新驱动队列，并把连续失败计数清零。
 * 队列正常运行时调用是安全的 no-op（kick 见 active 非空即返回）。
 */
export async function POST(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  getDownloadManager().resumeQueue();
  return NextResponse.json({ ok: true });
}
