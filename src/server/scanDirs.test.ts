import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb, runMigrations } from "./db";
import { getConfiguredScanDirs, setConfiguredScanDirs } from "./scanDirs";

/** 每个用例独立的 :memory: 库 */
function makeDb(): Database.Database {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}

describe("scanDirs", () => {
  it("未配置时返回空数组", () => {
    const db = makeDb();
    expect(getConfiguredScanDirs(db)).toEqual([]);
  });

  it("写入后可读回，保持顺序", () => {
    const db = makeDb();
    setConfiguredScanDirs(db, ["/mnt/old/models", "/mnt/backup"]);
    expect(getConfiguredScanDirs(db)).toEqual(["/mnt/old/models", "/mnt/backup"]);
  });

  it("存的是坏 JSON 时降级为空数组，不抛错——设置项损坏不该让扫描整个报错", () => {
    const db = makeDb();
    db.prepare("INSERT INTO settings(key, value) VALUES('scan_extra_dirs', '{oops')").run();
    expect(getConfiguredScanDirs(db)).toEqual([]);
  });
});
