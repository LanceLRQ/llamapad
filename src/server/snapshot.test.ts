import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { openDb, runMigrations } from "./db";
import { createModelRepo } from "./repo/models";
import { AUTO_SNAPSHOT_KEY, isAutoSnapshotEnabled, maybeAutoSnapshot } from "./snapshot";

/**
 * 自动快照（M2 Task 8）：settings.auto_snapshot 缺省开；写 <configDir>/export/
 * latest.yaml；失败只 warn 不抛（备份不能阻塞主流程）。
 * configDir 由 PANEL_CONFIG 的 dirname 决定，与生产语义一致（export 目录 =
 * panel.yaml 同级的 export/）。
 */

/** 独立临时 configDir + PANEL_CONFIG 指向其下的 panel.yaml；返回 [dir, 还原函数] */
function useTmpConfig(label: string): [string, () => void] {
  const dir = path.join(tmpdir(), `llamapad-snapshot-${label}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const backup = process.env.PANEL_CONFIG;
  process.env.PANEL_CONFIG = path.join(dir, "panel.yaml");
  return [
    dir,
    () => {
      if (backup === undefined) delete process.env.PANEL_CONFIG;
      else process.env.PANEL_CONFIG = backup;
    },
  ];
}

function freshDb(): Database.Database {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}

function seedModel(db: Database.Database, name: string): void {
  createModelRepo(db).createModel({
    name,
    display_name: name,
    namespace: "main",
    gguf_file: `main/${name}.gguf`,
    overrides: {},
  });
}

describe("isAutoSnapshotEnabled", () => {
  it("缺省开；'0'/'false' 关；其他值视为开", () => {
    const db = freshDb();
    expect(isAutoSnapshotEnabled(db)).toBe(true);
    const set = (v: string) =>
      db
        .prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(AUTO_SNAPSHOT_KEY, v);
    set("0");
    expect(isAutoSnapshotEnabled(db)).toBe(false);
    set("false");
    expect(isAutoSnapshotEnabled(db)).toBe(false);
    set("1");
    expect(isAutoSnapshotEnabled(db)).toBe(true);
    db.close();
  });
});

describe("maybeAutoSnapshot", () => {
  it("缺省开启：写 <configDir>/export/latest.yaml，内容含模型与命名空间", () => {
    const [dir, restoreConfig] = useTmpConfig("on");
    const db = freshDb();
    seedModel(db, "snap-demo");
    try {
      const written = maybeAutoSnapshot(db);
      expect(written).toBe(true);
      const file = path.join(dir, "export", "latest.yaml");
      expect(existsSync(file)).toBe(true);
      const text = readFileSync(file, "utf8");
      expect(text).toContain("snap-demo");
      expect(text).toContain("default_config:");
      expect(text).toContain("namespaces:");
    } finally {
      restoreConfig();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("settings.auto_snapshot='0' 时不写（已存在的文件保持原样）", () => {
    const [dir, restoreConfig] = useTmpConfig("off");
    const db = freshDb();
    db.prepare("INSERT INTO settings(key, value) VALUES (?, ?)").run(AUTO_SNAPSHOT_KEY, "0");
    try {
      expect(maybeAutoSnapshot(db)).toBe(false);
      expect(existsSync(path.join(dir, "export"))).toBe(false);

      // 先开着写一次，再关掉改库：文件不被更新
      db.prepare("DELETE FROM settings WHERE key = ?").run(AUTO_SNAPSHOT_KEY);
      maybeAutoSnapshot(db);
      const file = path.join(dir, "export", "latest.yaml");
      writeFileSync(file, "SENTINEL", "utf8");
      db.prepare("INSERT INTO settings(key, value) VALUES (?, ?)").run(AUTO_SNAPSHOT_KEY, "0");
      seedModel(db, "after-off");
      expect(maybeAutoSnapshot(db)).toBe(false);
      expect(readFileSync(file, "utf8")).toBe("SENTINEL");
    } finally {
      restoreConfig();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("写盘失败只吞错不抛（export 路径被同名文件占据时）", () => {
    const [dir, restoreConfig] = useTmpConfig("fail");
    const db = freshDb();
    seedModel(db, "fail-demo");
    writeFileSync(path.join(dir, "export"), "I am a file", "utf8"); // 占位文件挡住目录
    try {
      expect(() => maybeAutoSnapshot(db)).not.toThrow();
      expect(maybeAutoSnapshot(db)).toBe(false);
    } finally {
      restoreConfig();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
