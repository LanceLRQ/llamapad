import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runMigrations, openDb, getDb, _resetDbForTest } from "./db";

it("迁移后包含全部表且版本正确", () => {
  const db = openDb(":memory:");
  runMigrations(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
  for (const t of ["namespaces", "models", "settings", "admins", "api_tokens", "events"])
    expect(tables).toContain(t);
  expect(db.pragma("user_version", { simple: true })).toBe(1);
});

it("重复执行迁移是幂等的", () => {
  const db = openDb(":memory:");
  runMigrations(db);
  runMigrations(db); // 不应抛错、不重复建表
  expect(db.pragma("user_version", { simple: true })).toBe(1);
});

describe("getDb 单例", () => {
  const dbBackup = process.env.PANEL_DB;
  const tmpDbPath = path.join(tmpdir(), `llamapad-getDb-test-${process.pid}.db`);

  afterEach(() => {
    _resetDbForTest();
    if (dbBackup === undefined) delete process.env.PANEL_DB;
    else process.env.PANEL_DB = dbBackup;
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(tmpDbPath + suffix, { force: true });
    }
  });

  it("首次调用打开并迁移，之后复用同一实例", () => {
    process.env.PANEL_DB = tmpDbPath;
    const db1 = getDb();
    expect(db1.pragma("user_version", { simple: true })).toBe(1); // 已迁移
    expect(db1.open).toBe(true);
    const db2 = getDb();
    expect(db2).toBe(db1); // 模块级缓存，同一实例
  });

  it("_resetDbForTest 关闭连接并清缓存，下次 getDb 得到新实例", () => {
    process.env.PANEL_DB = tmpDbPath;
    const db1 = getDb();
    _resetDbForTest();
    expect(db1.open).toBe(false); // 已关闭
    const db2 = getDb();
    expect(db2).not.toBe(db1);
    expect(db2.pragma("user_version", { simple: true })).toBe(1); // 仍迁移到位
  });
});
