import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runMigrations, openDb, getDb, _resetDbForTest } from "./db";
import { MIGRATIONS } from "./migrations";

it("迁移后包含全部表且版本正确", () => {
  const db = openDb(":memory:");
  runMigrations(db);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
  for (const t of ["namespaces", "models", "settings", "admins", "api_tokens", "events"])
    expect(tables).toContain(t);
  expect(db.pragma("user_version", { simple: true })).toBe(2);
});

it("重复执行迁移是幂等的", () => {
  const db = openDb(":memory:");
  runMigrations(db);
  runMigrations(db); // 不应抛错、不重复建表
  expect(db.pragma("user_version", { simple: true })).toBe(2);
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
    expect(db1.pragma("user_version", { simple: true })).toBe(2); // 已迁移
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
    expect(db2.pragma("user_version", { simple: true })).toBe(2); // 仍迁移到位
  });
});

describe("migration v2：下载系统三表", () => {
  it("全新库迁移后包含 v2 三表且 v1 六表仍在，版本为 2", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    for (const t of ["download_tasks", "download_history", "hf_token"])
      expect(tables).toContain(t);
    for (const t of ["namespaces", "models", "settings", "admins", "api_tokens", "events"])
      expect(tables).toContain(t);
    expect(db.pragma("user_version", { simple: true })).toBe(2);
  });

  it("v1 库增量升级到 v2，既有数据保留", () => {
    const db = openDb(":memory:");
    // 手工构造 v1 库：只执行 v1 脚本并固定 user_version=1（不走 runMigrations，绕过 v2）
    db.exec(MIGRATIONS[0]);
    db.pragma("user_version = 1");
    db.prepare("INSERT INTO namespaces(name, created_at) VALUES (?, ?)").run("default", 111);
    db.prepare(
      "INSERT INTO models(name, display_name, namespace, gguf_file, overrides, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("qwen3", "Qwen3", "default", "qwen3.gguf", "{}", 222, 333);

    runMigrations(db); // 只应执行 v2 增量

    expect(db.pragma("user_version", { simple: true })).toBe(2);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    for (const t of ["download_tasks", "download_history", "hf_token"])
      expect(tables).toContain(t);
    const model = db.prepare("SELECT name, display_name, namespace, gguf_file FROM models").get() as {
      name: string; display_name: string; namespace: string; gguf_file: string;
    };
    expect(model).toEqual({ name: "qwen3", display_name: "Qwen3", namespace: "default", gguf_file: "qwen3.gguf" });
  });

  it("download_tasks 关键列齐全", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const cols = (db.prepare("PRAGMA table_info(download_tasks)").all() as { name: string }[]).map((r) => r.name);
    const expected = [
      "id", "model_name", "kind", "source", "repo", "url", "file", "target_rel",
      "shard_index", "shard_total", "expected_size", "sha256", "status",
      "downloaded_bytes", "error", "created_at", "updated_at",
    ];
    expect([...cols].sort()).toEqual([...expected].sort()); // 集合相等（不关心顺序）
    expect(cols).toHaveLength(expected.length); // 且无多余列
  });
});
