import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { clientSource, pruneExpiredEvents, recordEvent } from "./events";
import { openDb, runMigrations } from "./db";

function makeDb(): Database.Database {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}

describe("recordEvent", () => {
  it("写入 kind 与 message，ts 为毫秒时间戳", () => {
    const db = makeDb();
    const before = Date.now();
    recordEvent(db, "auth.login", "登录成功 来源 1.2.3.4");
    const row = db.prepare("SELECT ts, kind, message FROM events").get() as {
      ts: number;
      kind: string;
      message: string;
    };
    expect(row.kind).toBe("auth.login");
    expect(row.message).toBe("登录成功 来源 1.2.3.4");
    expect(row.ts).toBeGreaterThanOrEqual(before);
  });

  it("多次写入按序追加（AUTOINCREMENT 主键）", () => {
    const db = makeDb();
    recordEvent(db, "auth.login_failed", "a");
    recordEvent(db, "auth.login", "b");
    const rows = db.prepare("SELECT id, kind FROM events ORDER BY id").all() as {
      id: number;
      kind: string;
    }[];
    expect(rows.map((r) => r.kind)).toEqual(["auth.login_failed", "auth.login"]);
    expect(rows[1].id).toBeGreaterThan(rows[0].id);
  });
});

describe("clientSource", () => {
  it("单段 X-Forwarded-For 原样返回", () => {
    const req = new Request("http://x/api", {
      headers: { "x-forwarded-for": "203.0.113.7" },
    });
    expect(clientSource(req)).toBe("203.0.113.7");
  });

  it("多段（反代链）取首段并去空白", () => {
    const req = new Request("http://x/api", {
      headers: { "x-forwarded-for": "203.0.113.7 , 10.0.0.1, 10.0.0.2" },
    });
    expect(clientSource(req)).toBe("203.0.113.7");
  });

  it("无头返回未知来源（直连部署不猜回环地址）", () => {
    expect(clientSource(new Request("http://x/api"))).toBe("未知来源");
  });

  it("空白首段视作缺失", () => {
    const req = new Request("http://x/api", { headers: { "x-forwarded-for": " , 10.0.0.1" } });
    expect(clientSource(req)).toBe("未知来源");
  });
});

// 90 天，毫秒——与实现同一量纲，测试自行换算而不导入实现内部常量，避免
// 断言值与被测值来自同一处定义、边界改错也测不出来。
const RETENTION_MS = 90 * 24 * 3_600_000;
// 固定基准时刻：不用 Date.now()，避免边界断言随真实时钟浮动。
const NOW = Date.UTC(2026, 0, 1);

function insertEventAt(db: Database.Database, ts: number): void {
  db.prepare("INSERT INTO events(ts, kind, message) VALUES (?, 'k', 'm')").run(ts);
}

describe("pruneExpiredEvents", () => {
  it("删除早于 90 天的行，保留恰好 90 天前与当天的行", () => {
    const db = makeDb();
    insertEventAt(db, NOW - RETENTION_MS); // 恰好 90 天前：未早于保留窗口，保留
    insertEventAt(db, NOW - RETENTION_MS - 1); // 90 天零 1 毫秒前：早于保留窗口，删除
    insertEventAt(db, NOW); // 当天：保留

    const deleted = pruneExpiredEvents(db, NOW);

    expect(deleted).toBe(1);
    const remaining = db.prepare("SELECT ts FROM events ORDER BY ts").all() as { ts: number }[];
    expect(remaining.map((r) => r.ts)).toEqual([NOW - RETENTION_MS, NOW]);
  });

  it("返回值为实际删除行数", () => {
    const db = makeDb();
    insertEventAt(db, NOW - RETENTION_MS - 1);
    insertEventAt(db, NOW - RETENTION_MS - 2);
    insertEventAt(db, NOW); // 不该被删，不计入返回值

    expect(pruneExpiredEvents(db, NOW)).toBe(2);
  });

  it("空表不抛，返回 0", () => {
    const db = makeDb();
    expect(pruneExpiredEvents(db, NOW)).toBe(0);
  });
});

describe("startEventRetentionTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 每个用例都要一份全新的模块实例：函数内部用模块级变量记录定时器句柄
    // 判重，不重置模块的话，上一个用例启动过的定时器会让本用例误判为"已启动"。
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("启动时立即执行一轮清理，不等满 6 小时", async () => {
    const { startEventRetentionTimer: start } = await import("./events");
    const db = makeDb();
    insertEventAt(db, NOW - RETENTION_MS - 1);

    start(db, () => NOW);

    const row = db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number };
    expect(row.c).toBe(0);
  });

  it("重复调用不会起两个定时器", async () => {
    const { startEventRetentionTimer: start } = await import("./events");
    const db = makeDb();

    start(db, () => NOW);
    start(db, () => NOW);

    expect(vi.getTimerCount()).toBe(1);
  });
});
