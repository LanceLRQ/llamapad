import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getDownloadManager } from "@/server/locators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/downloads（M2 Task 5）：下载页数据源（薄壳调 manager + 直查 history）。
 *
 * 响应：`{ tasks: [...], history: [...] }`
 * - tasks：manager.listTasks()（含进度与队列位置，id 倒序）
 * - history：download_history 倒序 20 条，files JSON 反序列化为数组
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const tasks = getDownloadManager().listTasks();
  const rows = getDb()
    .prepare("SELECT * FROM download_history ORDER BY id DESC LIMIT 20")
    .all() as {
    id: number;
    model_name: string;
    files: string;
    total_bytes: number;
    status: string;
    finished_at: number;
  }[];
  const history = rows.map((row) => ({
    id: row.id,
    model: row.model_name,
    files: JSON.parse(row.files) as { file: string; target_rel: string; bytes: number }[],
    totalBytes: row.total_bytes,
    status: row.status,
    finishedAt: new Date(row.finished_at).toISOString(),
  }));
  return NextResponse.json({ tasks, history });
}
