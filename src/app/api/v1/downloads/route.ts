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
 * - history：download_history 倒序 20 条，files JSON 反序列化为数组，
 *   并带上本地获取批次的 sourcePath / localAction 标记（纯下载批次为 null）
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const tasks = getDownloadManager().listTasks();
  const rows = getDb()
    .prepare("SELECT * FROM download_history ORDER BY id DESC LIMIT 20")
    .all() as {
    id: number;
    batch_id: string;
    label: string;
    files: string;
    total_bytes: number;
    status: string;
    finished_at: number;
    source_path: string | null;
    local_action: string | null;
  }[];
  const history = rows.map((row) => ({
    id: row.id,
    batchId: row.batch_id,
    label: row.label,
    // 逐文件的 source_path / local_action 由 archiveIfBatchDone 写进
    // download_history.files（manager.ts:484-486），本路由只原样透传；补进
    // 断言是让声明与实际下发的内容一致（下载任务没有这两键，故设为可选），
    // 读者是前端的 describeHistoryFiles
    files: JSON.parse(row.files) as {
      file: string;
      target_rel: string;
      bytes: number;
      source_path?: string | null;
      local_action?: string | null;
    }[],
    totalBytes: row.total_bytes,
    status: row.status,
    finishedAt: new Date(row.finished_at).toISOString(),
    // 本地获取批次的标记（v17 两列，manager.archiveIfBatchDone 写入）：纯下载
    // 批次两项都是 null。localAction 可能是逗号分隔的多个动作（一批里既有
    // 移动又有链接）
    sourcePath: row.source_path,
    localAction: row.local_action,
  }));
  return NextResponse.json({ tasks, history });
}
