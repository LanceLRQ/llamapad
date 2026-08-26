import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { sharedLogBufferStore, startLogsStream } from "@/server/logsStream";
import { getRuntimeService, getSharedDockerAdapter } from "@/server/locators";
import { decorateRuntimeStatus } from "@/server/modelsView";
import { sseResponse } from "@/server/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/logs/stream：实时容器日志（SSE，M3 Task 1）
 *
 * 鉴权同普通 route（SSE 也是请求：无凭证直接 401 JSON，不升级为事件流）。
 * 核心行为在 src/server/logsStream.ts（缓冲补发 / 容器切换 / waiting），
 * 此处只是组装：适配器 followLogs + decorateRuntimeStatus 的 displayName。
 *
 * 事件形态（data 均为单行 JSON）：
 * - { "type": "container", "name": <displayName> }：当前接入的容器（切换时重发）
 * - { "type": "log", "line": <一行日志> }：日志行，帧带递增 `id:`（行号 per container）
 * - { "type": "waiting" }：无运行容器（每轮空窗只发一次）
 *
 * 断线重连：EventSource 自动带 Last-Event-ID 重放请求头 → 服务端先补发
 * 缓冲中 id 之后的行（模块级共享缓冲，每容器最近 500 行）再接实时。
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const db = getDb();
  const runtimeService = getRuntimeService();
  // 共享单例（globalThis）：本 route 曾直接 getDockerAdapter（模块级 Map），
  // dev 双模块图下与 start 路由各持一份 mock——容器表互不可见，followLogs
  // 拿不到容器静默空转（生产单模块图无此问题，dev 必现偶现）。见 locators 注释。
  const adapter = getSharedDockerAdapter();
  const lastEventId = req.headers.get("last-event-id");

  return sseResponse((session, controller) => {
    const stream = startLogsStream(
      session,
      {
        adapter,
        getRunning: async () => {
          const view = await decorateRuntimeStatus(db, runtimeService);
          return view.running
            ? { container: view.running.container, displayName: view.running.displayName }
            : null;
        },
      },
      { lastEventId, store: sharedLogBufferStore },
    );

    // 客户端断开（EventSource.close / 连接重置）：停 follow 句柄与轮询；
    // sseResponse 的 cancel 回收心跳定时器，连接由 controller.close 收尾
    req.signal.addEventListener("abort", () => {
      void stream.stop().then(() => controller.close());
    });
  });
}
