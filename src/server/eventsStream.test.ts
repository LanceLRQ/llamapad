import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDb, runMigrations } from "./db";
import { EVENTS_POLL_MS, EVENTS_SNAPSHOT_LIMIT, startEventsStream } from "./eventsStream";
import type { SseSession } from "./sse";

/**
 * 事件流核心逻辑测试（M3 Task 7 任务 A）
 *
 * 全部注入 :memory: db + 录制式 session + fake timer：
 * - 快照：连接建立即发最近 20 条倒序，lastEmittedId 取快照最大 id
 * - 增量：每 2s 查 id > lastEmittedId 升序发 type:"event"；无新静默
 * - 跨连接：各连接的 lastEmittedId 独立（新连接的快照已含旧增量，不重放）
 * - stop：清 interval（vi.getTimerCount 断言无悬挂定时器）
 */

interface EventRow {
  id: number;
  ts: number;
  kind: string;
  message: string;
}

let db: Database.Database;

beforeEach(() => {
  db = openDb(":memory:");
  runMigrations(db);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** 插入一条事件（ts 缺省取递增值保证倒序稳定）并返回行 */
function insertEvent(kind = "model.start", message = "e", ts?: number): EventRow {
  const maxTs = (db.prepare("SELECT MAX(ts) AS m FROM events").get() as { m: number | null }).m ?? 0;
  const info = db
    .prepare("INSERT INTO events(ts, kind, message) VALUES (?, ?, ?)")
    .run(ts ?? maxTs + 1000, kind, message);
  return { id: Number(info.lastInsertRowid), ts: ts ?? maxTs + 1000, kind, message };
}

/** 录制式 session：按序记下每次 send 的 (event, id) */
function recordingSession() {
  const events: { event: unknown; id?: number | string }[] = [];
  const session: SseSession = {
    send: (event, id) => events.push({ event, id }),
    comment: () => undefined,
  };
  return { session, events };
}

describe("startEventsStream：初始快照", () => {
  it("连接建立即发 snapshot：最近 20 条倒序（ts DESC, id DESC），不带 id 帧", () => {
    for (let i = 1; i <= 25; i++) insertEvent("model.start", `e-${i}`);
    const { session, events } = recordingSession();

    startEventsStream(session, db);

    expect(events).toHaveLength(1);
    const frame = events[0].event as { type: string; events: EventRow[] };
    expect(frame.type).toBe("snapshot");
    expect(frame.events).toHaveLength(EVENTS_SNAPSHOT_LIMIT);
    // 倒序：最新（id 25）在最前，最旧为 id 6（25 条中扔掉最早 5 条）
    expect(frame.events[0]).toMatchObject({ id: 25, message: "e-25" });
    expect(frame.events[19]).toMatchObject({ id: 6, message: "e-6" });
    expect(events[0].id).toBeUndefined();
  });

  it("空表：snapshot.events 为空数组（客户端渲染空态）", () => {
    const { session, events } = recordingSession();
    startEventsStream(session, db);
    expect(events).toEqual([{ event: { type: "snapshot", events: [] }, id: undefined }]);
  });
});

describe("startEventsStream：增量推送", () => {
  it("快照后新插入的事件在下一轮 2s 查询到达（type:event，字段平铺）", () => {
    insertEvent();
    const { session, events } = recordingSession();
    startEventsStream(session, db);
    const baseline = events.length;

    const row = insertEvent("model.stop", "停止模型");
    vi.advanceTimersByTime(EVENTS_POLL_MS);

    expect(events).toHaveLength(baseline + 1);
    expect(events[baseline]).toEqual({ event: { type: "event", ...row }, id: undefined });
  });

  it("一轮内插入多条：升序发（id 升序），lastEmittedId 推进到最大", () => {
    const { session, events } = recordingSession();
    startEventsStream(session, db);

    const r1 = insertEvent("model.start", "a");
    const r2 = insertEvent("model.stop", "b");
    const r3 = insertEvent("model.delete", "c");
    vi.advanceTimersByTime(EVENTS_POLL_MS);

    const incremental = events.slice(1).map((e) => e.event as EventRow & { type: string });
    expect(incremental.map((e) => e.id)).toEqual([r1.id, r2.id, r3.id]);
    expect(incremental.map((e) => e.type)).toEqual(["event", "event", "event"]);

    // lastEmittedId 已到 r3：再插入 r4 之前空转一轮不发包，r4 只到达一次
    const baseline = events.length;
    vi.advanceTimersByTime(EVENTS_POLL_MS * 3);
    expect(events).toHaveLength(baseline); // 无新：静默（心跳由 sseResponse 负责）

    const r4 = insertEvent("model.update", "d");
    vi.advanceTimersByTime(EVENTS_POLL_MS);
    expect(events).toHaveLength(baseline + 1);
    expect(events[baseline].event).toMatchObject({ type: "event", id: r4.id });
  });

  it("同 ts 的事件按自增 id 判定先后（增量查询按 id 而非 ts）", () => {
    const sharedTs = 1_700_000_000_000;
    insertEvent("model.start", "s1", sharedTs);
    const { session, events } = recordingSession();
    startEventsStream(session, db);

    const later = insertEvent("model.stop", "same-ms", sharedTs);
    vi.advanceTimersByTime(EVENTS_POLL_MS);
    expect(events).toHaveLength(2);
    expect(events[1].event).toMatchObject({ type: "event", id: later.id });
  });
});

describe("startEventsStream：跨连接独立性", () => {
  it("后建立的连接快照已含此前增量，不重放；各自只收连接建立后新增的事件", () => {
    insertEvent("model.start", "old");
    const connA = recordingSession();
    startEventsStream(connA.session, db);

    // A 连接期间新增两条 → A 收到
    const r1 = insertEvent("model.stop", "mid-1");
    const r2 = insertEvent("model.stop", "mid-2");
    vi.advanceTimersByTime(EVENTS_POLL_MS);
    expect(connA.events.filter((e) => (e.event as EventRow).id === r1.id)).toHaveLength(1);
    expect(connA.events.filter((e) => (e.event as EventRow).id === r2.id)).toHaveLength(1);

    // B 后建立：快照含 r1/r2（无重放），只收此后新增
    const connB = recordingSession();
    startEventsStream(connB.session, db);
    const snapshot = connB.events[0].event as { type: string; events: EventRow[] };
    expect(snapshot.events.some((e) => e.id === r1.id)).toBe(true);
    expect(snapshot.events.some((e) => e.id === r2.id)).toBe(true);

    const r3 = insertEvent("model.start", "after-b");
    vi.advanceTimersByTime(EVENTS_POLL_MS);
    expect(connB.events.filter((e) => (e.event as EventRow).id === r3.id)).toHaveLength(1);
    // A 也收到 r3（仍在线）；B 未把 r1/r2 当增量再发一遍
    expect(connA.events.filter((e) => (e.event as EventRow).id === r3.id)).toHaveLength(1);
    expect(connB.events).toHaveLength(2);
  });
});

describe("startEventsStream：stop 清理", () => {
  it("stop 清 interval（定时器数归零）且幂等；stop 后新事件不再推送", () => {
    insertEvent();
    const { session, events } = recordingSession();
    const stream = startEventsStream(session, db);

    expect(vi.getTimerCount()).toBe(1);
    stream.stop();
    stream.stop(); // 幂等
    expect(vi.getTimerCount()).toBe(0);

    insertEvent("model.start", "after-stop");
    vi.advanceTimersByTime(EVENTS_POLL_MS * 2);
    expect(events).toHaveLength(1); // 仍只有初始快照
  });
});
