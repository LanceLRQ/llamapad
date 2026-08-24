import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { MIGRATIONS } from "./migrations";

/**
 * 获取 panel.db 路径：优先读环境变量 PANEL_DB，未设置时默认 dev-data/panel.db（相对 cwd）。
 */
export function getDbPath(): string {
  return process.env.PANEL_DB ?? path.join("dev-data", "panel.db");
}

/**
 * 打开 SQLite 连接：非 :memory: 路径时自动创建父目录；开启 WAL 与外键约束。
 * 注意：:memory: 下 journal_mode 会返回 "memory"，WAL 设置无害。
 */
export function openDb(dbPath: string): Database.Database {
  if (dbPath !== ":memory:") {
    const dir = path.dirname(dbPath);
    if (dir && dir !== ".") {
      mkdirSync(dir, { recursive: true });
    }
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

/**
 * 版本化迁移：读取 PRAGMA user_version 作为当前版本，
 * 逐版本执行 MIGRATIONS[currentVersion] 及之后的脚本（每个版本一个事务，成功后更新 user_version）。
 * 已是最新版本时直接跳过，因此重复调用安全（幂等）。
 */
export function runMigrations(db: Database.Database): void {
  const currentVersion = db.pragma("user_version", { simple: true }) as number;

  for (let v = currentVersion; v < MIGRATIONS.length; v++) {
    const script = MIGRATIONS[v];
    db.transaction(() => {
      db.exec(script);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
