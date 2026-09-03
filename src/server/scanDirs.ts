import type Database from "better-sqlite3";

/**
 * 自定义扫描目录（设计 §6.2）：宿主机视角路径数组，存 settings 表。
 * 坏 JSON 一律降级为空数组——一个损坏的设置项不该让整个扫描页报错。
 *
 * 本模块从任务 12「scan API」提前拆出（任务 10 起，本地权重迁移批②）：
 * acquire 路由的服务端重验需要拿「用户配置的自定义扫描目录」并入允许范围，
 * 这个依赖早于任务 12 落地，计划编号先后与依赖方向没对齐，遂在此把读写
 * 两个纯函数先落地。任务 12 只需在此基础上补 scan 路由本身。
 */
const KEY = "scan_extra_dirs";

export function getConfiguredScanDirs(db: Database.Database): string[] {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
  if (!row) return [];
  try {
    const parsed: unknown = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function setConfiguredScanDirs(db: Database.Database, dirs: readonly string[]): void {
  db.prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(KEY, JSON.stringify(dirs));
}
