/**
 * 事件流核心逻辑（M3 Task 7 任务 A）
 *
 * GET /api/v1/events/stream 的全部可单测行为收敛在此，route 只是薄壳：
 * - 连接建立即发快照：最近 20 条倒序（与 GET /api/v1/events 及概览事件卡同序）
 * - 每 2s 查 `id > lastEmittedId` 的增量（升序发，type:"event"），推进水位
 * - 无新不发包：连接保活交给 sseResponse 的 15s 心跳，不制造无效流量
 *
 * 与 logsStream 的 Last-Event-ID 补发不同，这里断线重连不靠 id 帧重放——
 * EventSource 重连后服务端重发快照即可（客户端 snapshot 消息幂等替换整表），
 * 因此增量帧不带 `id:` 行，避免暗示存在重放语义。
 */
import type Database from "better-sqlite3";
import type { SseSession } from "./sse";

/** 快照条数（概览事件卡与 GET /api/v1/events 的默认 limit 一致） */
export const EVENTS_SNAPSHOT_LIMIT = 20;

/** 增量轮询间隔：事件是低频写（启停/下载/导入），2s 感知延迟足够且查询极轻 */
export const EVENTS_POLL_MS = 2_000;

/** events 表行（与 GET /api/v1/events 的响应行结构一致） */
export interface EventRow {
  id: number;
  ts: number;
  kind: string;
  message: string;
}

export interface EventsStreamOptions {
  /** 增量轮询间隔（毫秒）；route 用默认 2s，测试注入小值 */
  pollMs?: number;
  /** 快照条数；测试注入小值 */
  snapshotLimit?: number;
}

/** 事件流句柄：stop 清 interval，幂等 */
export interface EventsStreamHandle {
  stop(): void;
}

export function startEventsStream(
  session: SseSession,
  db: Database.Database,
  options: EventsStreamOptions = {},
): EventsStreamHandle {
  const { pollMs = EVENTS_POLL_MS, snapshotLimit = EVENTS_SNAPSHOT_LIMIT } = options;
  const stmt = {
    recent: db.prepare("SELECT id, ts, kind, message FROM events ORDER BY ts DESC, id DESC LIMIT ?"),
    after: db.prepare("SELECT id, ts, kind, message FROM events WHERE id > ? ORDER BY id ASC"),
  };

  // 初始快照（同步发，连接建立即有内容）；水位取快照最大 id（空表为 0）
  const recent = stmt.recent.all(snapshotLimit) as EventRow[];
  let lastEmittedId = recent.length > 0 ? recent[0].id : 0;
  session.send({ type: "snapshot", events: recent });

  const timer = setInterval(() => {
    const rows = stmt.after.all(lastEmittedId) as EventRow[];
    if (rows.length === 0) return; // 无新：静默（保活由 SSE 心跳负责）
    for (const row of rows) session.send({ type: "event", ...row });
    lastEmittedId = rows[rows.length - 1].id;
  }, pollMs);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
