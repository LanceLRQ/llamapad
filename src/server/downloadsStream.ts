/**
 * 下载流核心逻辑（M3 Task 7 任务 B）
 *
 * GET /api/v1/downloads/stream 的全部可单测行为收敛在此，route 只是薄壳：
 * - 连接建立先发一次 history（首 20，倒序），此后不再发（历史只在连接期首刷）
 * - 每 1s 发一拍全量快照 `{type:"tasks", tasks, queue:{head}}`
 *
 * 全量快照的取舍：不做增量 diff——单面板的下载任务是几行到几十行的小表，
 * 序列化后仅几 KB～几十 KB，diff 逻辑（按 id 对齐 + 字段比较 + 删除语义）的
 * 复杂度远超收益；固定节拍全量 + 客户端幂等替换 state 简单可靠，进度
 * downloadedBytes 每 500ms 落库、1s 节拍读取天然对齐。
 */
import type Database from "better-sqlite3";
import type { DownloadManager } from "./download/manager";
import type { SseSession } from "./sse";

/** tasks 全量快照节拍（毫秒）：进度写库 500ms 节流的对齐上限 */
export const DOWNLOADS_TICK_MS = 1_000;

/** history 连接期首刷条数（与 GET /api/v1/downloads 一致） */
export const HISTORY_LIMIT = 20;

/** 与 GET /api/v1/downloads 的 history 行结构一致（files JSON 已反序列化） */
export interface DownloadHistoryRow {
  id: number;
  batchId: string;
  label: string;
  files: { file: string; target_rel: string; bytes: number }[];
  totalBytes: number;
  status: string;
  finishedAt: string;
  /** 本地获取批次的源路径与手段（v17 两列）；纯下载批次为 null。
   *  localAction 可能是逗号分隔的多个动作（同一批里既有移动又有链接） */
  sourcePath: string | null;
  localAction: string | null;
}

/** db → history 行映射（倒序首 HISTORY_LIMIT 条；stream route 与 GET /downloads 同源语义） */
export function listDownloadHistory(db: Database.Database): DownloadHistoryRow[] {
  const rows = db
    .prepare("SELECT * FROM download_history ORDER BY id DESC LIMIT ?")
    .all(HISTORY_LIMIT) as {
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
  return rows.map((row) => ({
    id: row.id,
    batchId: row.batch_id,
    label: row.label,
    files: JSON.parse(row.files) as DownloadHistoryRow["files"],
    totalBytes: row.total_bytes,
    status: row.status,
    finishedAt: new Date(row.finished_at).toISOString(),
    sourcePath: row.source_path,
    localAction: row.local_action,
  }));
}

/** startDownloadsStream 的依赖注入点：manager 只取两个读方法，测试注入 fake */
export interface DownloadsStreamDeps {
  manager: Pick<DownloadManager, "listTasks" | "getQueueHead">;
  listHistory(): DownloadHistoryRow[];
}

export interface DownloadsStreamOptions {
  /** 快照节拍（毫秒）；route 用默认 1s，测试注入小值 */
  tickMs?: number;
}

/** 下载流句柄：stop 清 interval，幂等 */
export interface DownloadsStreamHandle {
  stop(): void;
}

export function startDownloadsStream(
  session: SseSession,
  deps: DownloadsStreamDeps,
  options: DownloadsStreamOptions = {},
): DownloadsStreamHandle {
  const { tickMs = DOWNLOADS_TICK_MS } = options;

  // 连接建立：先补一次历史（历史是归档事实，连接期不变，无需随拍重发）
  session.send({ type: "history", history: deps.listHistory() });

  const emitTasks = (): void => {
    session.send({
      type: "tasks",
      tasks: deps.manager.listTasks(),
      queue: { head: deps.manager.getQueueHead() },
    });
  };
  emitTasks(); // 首拍立即发（不等 1s）：curl/客户端连上即见当前队列
  const timer = setInterval(emitTasks, tickMs);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
