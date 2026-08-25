/**
 * SSE（Server-Sent Events）响应工具（M3 Task 1）
 *
 * 面板所有服务端推送（当前：容器日志流 /api/v1/logs/stream）共用：
 * - 统一响应头（text/event-stream + 禁缓存 + 禁代理缓冲）
 * - 统一帧格式：id 帧可选、data 恒为单行 JSON、comment 帧作心跳
 * - session 内置 15s 心跳（comment "ping"），控制器 close/error 或客户端
 *   断开（cancel）时自动清定时器——不留悬挂 interval 拖住进程
 */

/** 心跳间隔（毫秒）：15s，短于常见代理的空闲超时（nginx 60s / lb 30s+） */
export const SSE_HEARTBEAT_MS = 15_000;

/** 写帧的最小接口：只依赖 enqueue/close/error，便于包装拦截 */
export interface SseSession {
  /** 发一帧事件：id 给定时先写 `id: <id>` 行，data 为单行 JSON */
  send(event: unknown, id?: number | string): void;
  /** 发一帧注释：`: <text>`，对客户端不可见，用于心跳保活 */
  comment(text?: string): void;
}

/**
 * 构造 SSE 响应：setup 在流 start 时执行一次，拿到 session 写帧、
 * controller 可提前 close()/error()（经包装，触发心跳清理）。
 * setup 可以是 async——resolve 前不关闭流（长连接语义由调用方掌控）。
 */
export function sseResponse(
  setup: (session: SseSession, controller: ReadableStreamDefaultController) => void | Promise<void>,
): Response {
  const encoder = new TextEncoder();
  /** 心跳句柄；undefined = 已清理 */
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  /** 清心跳并标记关闭：控制器 close/error、客户端 cancel、setup 抛错都会走到 */
  function teardown(): void {
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    closed = true;
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const session: SseSession = {
        send(event, id) {
          if (closed) return;
          let frame = "";
          if (id !== undefined) frame += `id: ${id}\n`;
          frame += `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(frame));
        },
        comment(text) {
          if (closed) return;
          controller.enqueue(encoder.encode(`: ${text ?? ""}\n\n`));
        },
      };

      // 包装 controller：close/error 先走 teardown 再下传，保证心跳定时器被清
      const wrapped: ReadableStreamDefaultController = {
        get desiredSize() {
          return controller.desiredSize;
        },
        enqueue: (chunk) => controller.enqueue(chunk),
        close: () => {
          teardown();
          controller.close();
        },
        error: (reason) => {
          teardown();
          controller.error(reason);
        },
      };

      heartbeat = setInterval(() => session.comment("ping"), SSE_HEARTBEAT_MS);

      void Promise.resolve(setup(session, wrapped)).catch(() => {
        // setup 抛错：清心跳并把错误传给流（客户端 read 会 reject 而非悬挂）
        teardown();
        try {
          controller.error(new Error("sse setup failed"));
        } catch {
          // close 之后再 error 会抛 TypeError——setup 自己 close 过就到此为止
        }
      });
    },
    // 客户端断开（reader.cancel / 连接重置）：清心跳
    cancel() {
      teardown();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
