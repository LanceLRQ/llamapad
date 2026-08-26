import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { clientSource, recordEvent } from "./events";
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
