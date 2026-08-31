import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runMigrations, openDb, getDb, _resetDbForTest } from "./db";
import { MIGRATIONS } from "./migrations";

// 本文件多处硬编码断言「迁移到最新后 user_version 应为 N」（N = MIGRATIONS.length）。
// 每次在 migrations.ts 追加一版新迁移，这里全部 toBe(N) 都要同步改成新的最新版本号
// （当前为 11）——否则这些断言会全体失败，但那是断言本身过时，不是迁移脚本坏了。

it("迁移后包含全部表且版本正确", () => {
  const db = openDb(":memory:");
  runMigrations(db);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
  for (const t of ["namespaces", "models", "settings", "admins", "api_tokens", "events"])
    expect(tables).toContain(t);
  expect(db.pragma("user_version", { simple: true })).toBe(11);
});

it("重复执行迁移是幂等的", () => {
  const db = openDb(":memory:");
  runMigrations(db);
  runMigrations(db); // 不应抛错、不重复建表
  expect(db.pragma("user_version", { simple: true })).toBe(11);
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
    expect(db1.pragma("user_version", { simple: true })).toBe(11); // 已迁移
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
    expect(db2.pragma("user_version", { simple: true })).toBe(11); // 仍迁移到位
  });
});

describe("migration v2：下载系统三表", () => {
  it("全新库迁移后包含 v2 三表且 v1 六表仍在，版本为 4", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    for (const t of ["download_tasks", "download_history", "hf_token"])
      expect(tables).toContain(t);
    for (const t of ["namespaces", "models", "settings", "admins", "api_tokens", "events"])
      expect(tables).toContain(t);
    expect(db.pragma("user_version", { simple: true })).toBe(11);
  });

  it("手工构造到 v2 的库增量升级到最新，既有数据保留", () => {
    const db = openDb(":memory:");
    // 手工构造 v2 库：只执行 v1+v2 脚本并固定 user_version=2（不走 runMigrations，绕过 v3）
    db.exec(MIGRATIONS[0]);
    db.exec(MIGRATIONS[1]);
    db.pragma("user_version = 2");
    db.prepare("INSERT INTO namespaces(name, created_at) VALUES (?, ?)").run("default", 111);
    db.prepare(
      "INSERT INTO models(name, display_name, namespace, gguf_file, overrides, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("qwen3", "Qwen3", "default", "qwen3.gguf", "{}", 222, 333);

    runMigrations(db); // 只应执行 v3 增量

    expect(db.pragma("user_version", { simple: true })).toBe(11);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    for (const t of ["download_tasks", "download_history", "hf_token", "metrics_bucket"])
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
      // v10 重建后的正式结构：model_name 换成 batch_id + repo_id，auto_start 随重建消失
      "id", "batch_id", "repo_id", "label", "kind", "source", "repo", "url", "file", "target_rel",
      "shard_index", "shard_total", "expected_size", "sha256", "status",
      "downloaded_bytes", "error", "created_at", "updated_at",
    ];
    expect([...cols].sort()).toEqual([...expected].sort()); // 集合相等（不关心顺序）
    expect(cols).toHaveLength(expected.length); // 且无多余列
  });
});

describe("migration v3：指标聚合桶", () => {
  it("v2 库增量升级到最新，metrics_bucket 列齐且复合主键正确", () => {
    const db = openDb(":memory:");
    db.exec(MIGRATIONS[0]);
    db.exec(MIGRATIONS[1]);
    db.pragma("user_version = 2");

    runMigrations(db);

    expect(db.pragma("user_version", { simple: true })).toBe(11);
    const cols = (db.prepare("PRAGMA table_info(metrics_bucket)").all() as { name: string }[]).map((r) => r.name);
    const expected = ["metric_id", "granularity", "bucket_start", "min", "max", "avg", "count"];
    expect([...cols].sort()).toEqual([...expected].sort()); // 集合相等（不关心顺序）
    expect(cols).toHaveLength(expected.length); // 且无多余列

    // 复合主键 (metric_id, granularity, bucket_start)：同键重复插入被约束拒绝
    const insert = db.prepare(
      "INSERT INTO metrics_bucket(metric_id, granularity, bucket_start, min, max, avg, count) VALUES ('m', 1, 100, 1, 1, 1, 1)"
    );
    insert.run();
    expect(() => insert.run()).toThrow(); // UNIQUE 约束
  });

  it("全新库迁移后 metrics_bucket 可正常读写（granularity 共表两种粒度）", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    db.prepare(
      "INSERT INTO metrics_bucket(metric_id, granularity, bucket_start, min, max, avg, count) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("m", 1, 60, 1, 2, 1.5, 2);
    db.prepare(
      "INSERT INTO metrics_bucket(metric_id, granularity, bucket_start, min, max, avg, count) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("m", 15, 0, 1, 2, 1.5, 2);
    const rows = db.prepare("SELECT metric_id, granularity, bucket_start FROM metrics_bucket ORDER BY granularity DESC").all();
    expect(rows).toEqual([
      { metric_id: "m", granularity: 15, bucket_start: 0 },
      { metric_id: "m", granularity: 1, bucket_start: 60 },
    ]);
  });
});

describe("migration v4：api_tokens 补 token_tail", () => {
  it("v3 库增量升级到 v4，既有行 token_tail 为 NULL（明文尾号不可逆推，属预期）", () => {
    const db = openDb(":memory:");
    db.exec(MIGRATIONS[0]);
    db.exec(MIGRATIONS[1]);
    db.exec(MIGRATIONS[2]);
    db.pragma("user_version = 3");
    db.prepare("INSERT INTO api_tokens(token_hash, name, created_at) VALUES (?, ?, ?)").run(
      "a".repeat(64),
      "legacy",
      111,
    );

    runMigrations(db);

    expect(db.pragma("user_version", { simple: true })).toBe(11);
    const legacy = db.prepare("SELECT token_tail FROM api_tokens WHERE name = 'legacy'").get() as {
      token_tail: string | null;
    };
    expect(legacy.token_tail).toBeNull();
  });

  it("全新库迁移后 api_tokens 列齐（含 token_tail）", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const cols = (db.prepare("PRAGMA table_info(api_tokens)").all() as { name: string }[]).map((r) => r.name);
    const expected = ["id", "token_hash", "name", "created_at", "token_tail"];
    expect([...cols].sort()).toEqual([...expected].sort()); // 集合相等（不关心顺序）
    expect(cols).toHaveLength(expected.length); // 且无多余列
  });
});

describe("migration v5：download_tasks 补 auto_start（U15 自动启动意图）", () => {
  it("v4 库增量升级到 v5，既有行 auto_start 为 0（无意图，属预期默认）", () => {
    const db = openDb(":memory:");
    for (const script of MIGRATIONS.slice(0, 4)) db.exec(script);
    db.pragma("user_version = 4");
    db.prepare(`
      INSERT INTO download_tasks(model_name, kind, source, file, target_rel, status, downloaded_bytes, created_at, updated_at)
      VALUES ('m', 'gguf', 'url', 'a.gguf', 'main/a.gguf', 'completed', 100, 1, 1)
    `).run();

    // 只应用 v5 本身，不再调用 runMigrations 跑到最新：v10 会整表重建，
    // model_name/auto_start 列与这行数据都会随之清空，与这条用例要验的
    // 「ALTER TABLE ADD COLUMN 对既有行的默认值回填」是两回事。
    db.exec(MIGRATIONS[4]);

    const row = db.prepare("SELECT auto_start FROM download_tasks").get() as { auto_start: number };
    expect(row.auto_start).toBe(0);
  });
});

describe("migration v11：下载表 repo_id 补 ON DELETE SET NULL（C1）", () => {
  it("v10 库增量升级到 v11，整表重建保留既有数据——这是相对 v10 当年 DROP+CREATE 的核心区别，不能退化回去", () => {
    const db = openDb(":memory:");
    // 手工构造到 v10 的库：v1..v10 共 10 个脚本（索引 0..9），固定 user_version=10，
    // 不走 runMigrations，绕过 v11
    for (const script of MIGRATIONS.slice(0, 10)) db.exec(script);
    db.pragma("user_version = 10");

    const repoInfo = db
      .prepare("INSERT INTO model_repos(repo, base_dir, created_at) VALUES (?, ?, ?)")
      .run("o/r", "hf", 100);
    const repoId = Number(repoInfo.lastInsertRowid);
    db.prepare(
      `INSERT INTO download_tasks
         (batch_id, repo_id, label, kind, source, file, target_rel, status, downloaded_bytes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("b1", repoId, "o/r", "file", "hf", "model.gguf", "hf/o/r/model.gguf", "downloading", 12345, 200, 300);
    db.prepare(
      `INSERT INTO download_history
         (batch_id, repo_id, label, files, total_bytes, status, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("b1", repoId, "o/r", "[]", 67890, "done", 400);

    runMigrations(db); // 只应执行 v11 增量

    expect(db.pragma("user_version", { simple: true })).toBe(11);

    // 行还在，且非平凡字段（downloaded_bytes/total_bytes）原样保留——
    // 不只是断行数，行数不变也可能是「先清空又插入了同名行」这种巧合
    const task = db
      .prepare("SELECT batch_id, repo_id, downloaded_bytes FROM download_tasks WHERE batch_id = 'b1'")
      .get() as { batch_id: string; repo_id: number; downloaded_bytes: number };
    expect(task).toEqual({ batch_id: "b1", repo_id: repoId, downloaded_bytes: 12345 });

    const history = db
      .prepare("SELECT batch_id, repo_id, total_bytes FROM download_history WHERE batch_id = 'b1'")
      .get() as { batch_id: string; repo_id: number; total_bytes: number };
    expect(history).toEqual({ batch_id: "b1", repo_id: repoId, total_bytes: 67890 });

    // 索引随 DROP TABLE 一起没了，必须在 RENAME 之后重建
    const index = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_download_tasks_batch'")
      .get();
    expect(index).toBeDefined();
  });
});
