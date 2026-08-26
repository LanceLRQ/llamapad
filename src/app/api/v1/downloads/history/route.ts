import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getDownloadManager } from "@/server/locators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DELETE /api/v1/downloads/history（UX P1 U25）：清除已结束的下载记录
 * （completed/failed/cancelled 任务行 + 全部历史归档）。未完成任务与磁盘文件
 * 不受影响。返回两处删除计数供 toast 反馈。
 */
export async function DELETE(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const { tasks, history } = getDownloadManager().clearFinished();
  return NextResponse.json({ clearedTasks: tasks, clearedHistory: history });
}
