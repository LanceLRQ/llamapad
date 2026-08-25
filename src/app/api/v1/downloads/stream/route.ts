import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { listDownloadHistory, startDownloadsStream } from "@/server/downloadsStream";
import { getDownloadManager } from "@/server/locators";
import { sseResponse } from "@/server/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/downloads/stream：下载任务进度流（SSE，M3 Task 7 任务 B）
 *
 * 鉴权同普通 route。核心行为在 src/server/downloadsStream.ts（history 首刷 /
 * tasks 全量节拍），此处只是组装：manager 走 locators 单例（内存队列状态跨
 * bundle 共享），history 直查 download_history。
 *
 * 事件形态（data 均为单行 JSON）：
 * - { "type": "history", "history": [...] }：连接建立发一次（首 20，倒序）
 * - { "type": "tasks", "tasks": [...], "queue": { "head": id|null } }：每 1s
 *   一拍全量快照（取舍见 downloadsStream.ts 文件头）
 *
 * 断线重连：EventSource 自动重连，重连后 history/tasks 首刷即对齐。
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const db = getDb();
  return sseResponse((session, controller) => {
    const stream = startDownloadsStream(session, {
      manager: getDownloadManager(),
      listHistory: () => listDownloadHistory(db),
    });

    // 客户端断开（EventSource.close / 连接重置）：停节拍 interval；
    // sseResponse 的 cancel 回收心跳定时器，连接由 controller.close 收尾
    req.signal.addEventListener("abort", () => {
      stream.stop();
      controller.close();
    });
  });
}
