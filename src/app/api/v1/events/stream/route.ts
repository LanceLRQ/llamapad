import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { startEventsStream } from "@/server/eventsStream";
import { sseResponse } from "@/server/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/events/stream：事件流（SSE，M3 Task 7 任务 A）
 *
 * 鉴权同普通 route（SSE 也是请求：无凭证直接 401 JSON，不升级为事件流）。
 * 核心行为在 src/server/eventsStream.ts（快照 / 增量 / 静默），此处只是组装。
 *
 * 事件形态（data 均为单行 JSON）：
 * - { "type": "snapshot", "events": [...] }：连接建立即发，最近 20 条倒序
 * - { "type": "event", "id", "ts", "kind", "message" }：增量（升序，2s 轮询）
 *
 * 断线重连：EventSource 自动重连，服务端重发快照即可对齐（客户端 snapshot
 * 消息幂等替换整表）——不做 Last-Event-ID 重放（理由见 eventsStream.ts）。
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  return sseResponse((session, controller) => {
    const stream = startEventsStream(session, getDb());

    // 客户端断开（EventSource.close / 连接重置）：停轮询 interval；
    // sseResponse 的 cancel 回收心跳定时器，连接由 controller.close 收尾
    req.signal.addEventListener("abort", () => {
      stream.stop();
      controller.close();
    });
  });
}
