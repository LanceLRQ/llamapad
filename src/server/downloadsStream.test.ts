import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDb, runMigrations } from "./db";
import {
  DOWNLOADS_TICK_MS,
  HISTORY_LIMIT,
  listDownloadHistory,
  startDownloadsStream,
} from "./downloadsStream";
import type { DownloadTaskView } from "./download/manager";
import type { SseSession } from "./sse";

/**
 * 下载流核心逻辑测试（M3 Task 7 任务 B）
 *
 * 注入 fake manager（可变任务表 / 队首）+ 录制式 session + fake timer：
 * - 连接建立：先发一次 history（首 20），随后立即发一拍 tasks
 * - 节拍：每 1s 全量快照一帧（内容跟随 manager 变化，进度 bytes 增长可见）
 * - stop：清 interval（vi.getTimerCount 断言无悬挂定时器）
 *
 * listDownloadHistory（db → history 行映射）用 :memory: db 直测。
 */

let db: Database.Database;

beforeEach(() => {
  db = openDb(":memory:");
  runMigrations(db);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** 录制式 session：按序记下每次 send 的 (event, id) */
function recordingSession() {
  const events: { event: unknown; id?: number | string }[] = [];
  const session: SseSession = {
    send: (event, id) => events.push({ event, id }),
    comment: () => undefined,
  };
  return { session, events };
}

function taskView(id: number, bytes: number, status: DownloadTaskView["status"] = "downloading"): DownloadTaskView {
  return {
    id,
    batchId: `batch-${id}`,
    repoId: null,
    label: `model-${id}`,
    kind: "gguf",
    source: "url",
    localAction: null,
    file: `${id}.gguf`,
    targetRel: `main/${id}.gguf`,
    shardIndex: null,
    shardTotal: null,
    expectedSize: 1000,
    sha256: null,
    status,
    downloadedBytes: bytes,
    error: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    queuePosition: status === "pending" ? 0 : null,
  };
}

/** 可变 fake manager：测试直接改 tasks / head 驱动快照内容 */
function fakeManager(initialTasks: DownloadTaskView[] = []) {
  const state = { tasks: initialTasks, head: null as number | null };
  return {
    manager: {
      listTasks: () => state.tasks,
      getQueueHead: () => state.head,
    },
    state,
  };
}

const cannedHistory = [{ id: 1, batchId: "b1", label: "m", files: [], totalBytes: 0, status: "completed", finishedAt: "1970-01-01T00:00:00.000Z", sourcePath: null, localAction: null }];

describe("startDownloadsStream：连接建立", () => {
  it("先发一次 history，紧接立即发第一拍 tasks（queue.head 透传）", () => {
    const { manager, state } = fakeManager([taskView(1, 100)]);
    state.head = 1;
    const { session, events } = recordingSession();

    startDownloadsStream(session, { manager, listHistory: () => cannedHistory });

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ event: { type: "history", history: cannedHistory }, id: undefined });
    expect(events[1]).toEqual({
      event: { type: "tasks", tasks: [taskView(1, 100)], queue: { head: 1 } },
      id: undefined,
    });
  });
});

describe("startDownloadsStream：tasks 节拍", () => {
  it("每 1s 一拍全量快照；内容跟随 manager 变化（bytes 增长可见）；history 只发一次", () => {
    const { manager, state } = fakeManager([taskView(1, 100)]);
    let historyCalls = 0;
    const { session, events } = recordingSession();

    startDownloadsStream(session, { manager, listHistory: () => (historyCalls++, cannedHistory) });

    state.tasks = [taskView(1, 300)];
    vi.advanceTimersByTime(DOWNLOADS_TICK_MS);
    state.tasks = [taskView(1, 700)];
    vi.advanceTimersByTime(DOWNLOADS_TICK_MS);
    // 空转一轮也照发（全量快照语义：无变化不特殊处理，客户端幂等替换）
    vi.advanceTimersByTime(DOWNLOADS_TICK_MS);

    const frames = events.map((e) => e.event as { type: string; tasks?: DownloadTaskView[] });
    expect(frames.filter((f) => f.type === "history")).toHaveLength(1);
    const tasksFrames = frames.filter((f) => f.type === "tasks");
    expect(tasksFrames).toHaveLength(4); // 首拍立即 + 3 拍
    expect(tasksFrames.map((f) => f.tasks![0].downloadedBytes)).toEqual([100, 300, 700, 700]);
    expect(historyCalls).toBe(1);
  });

  it("队列切换（head 变化）反映在下一拍 queue.head", () => {
    const { manager, state } = fakeManager([taskView(1, 0)]);
    const { session, events } = recordingSession();
    startDownloadsStream(session, { manager, listHistory: () => [] });

    state.head = 9;
    vi.advanceTimersByTime(DOWNLOADS_TICK_MS);

    const last = events[events.length - 1].event as { queue: { head: number | null } };
    expect(last.queue).toEqual({ head: 9 });
  });
});

describe("startDownloadsStream：stop 清理", () => {
  it("stop 清 interval 且幂等；stop 后不再发拍", () => {
    const { manager } = fakeManager();
    const { session, events } = recordingSession();
    const stream = startDownloadsStream(session, { manager, listHistory: () => [] });

    expect(vi.getTimerCount()).toBe(1);
    stream.stop();
    stream.stop(); // 幂等
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(DOWNLOADS_TICK_MS * 3);
    expect(events).toHaveLength(2); // 仍只有 history + 首拍
  });
});

describe("listDownloadHistory：db → 行映射", () => {
  it("倒序取首 20 条，files JSON 反序列化，finishedAt 转 ISO 字符串", () => {
    const insert = db.prepare(
      "INSERT INTO download_history(batch_id, label, files, total_bytes, status, finished_at) VALUES (?, ?, ?, ?, 'completed', ?)",
    );
    for (let i = 1; i <= 25; i++) {
      insert.run(`batch-${i}`, `model-${i}`, JSON.stringify([{ file: `${i}.gguf`, target_rel: `main/${i}.gguf`, bytes: i }]), i * 10, 1_700_000_000_000 + i);
    }

    const history = listDownloadHistory(db);
    expect(history).toHaveLength(HISTORY_LIMIT);
    expect(history[0]).toEqual({
      id: 25,
      batchId: "batch-25",
      label: "model-25",
      files: [{ file: "25.gguf", target_rel: "main/25.gguf", bytes: 25 }],
      totalBytes: 250,
      status: "completed",
      finishedAt: new Date(1_700_000_000_025).toISOString(),
      // 纯下载批次：本地获取的两个标记为 null（I4，v17 两列由归档写入）
      sourcePath: null,
      localAction: null,
    });
    expect(history[19].id).toBe(6); // 25 条中只留最新 20
  });

  it("本地获取批次带出 sourcePath / localAction", () => {
    db.prepare(
      `INSERT INTO download_history(batch_id, label, files, total_bytes, status, finished_at, source_path, local_action)
       VALUES ('b-local', 'o/R', '[]', 0, 'completed', 1, '/panel-models/loose/a.gguf', 'move,link')`,
    ).run();

    const row = listDownloadHistory(db)[0]!;
    expect(row.sourcePath).toBe("/panel-models/loose/a.gguf");
    expect(row.localAction).toBe("move,link");
  });

  it("空表返回空数组", () => {
    expect(listDownloadHistory(db)).toEqual([]);
  });
});
