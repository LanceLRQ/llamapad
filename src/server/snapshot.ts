import type Database from "better-sqlite3";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { toExportYaml } from "@/core/yamlIo";
import { getConfigPath } from "./panelConfig";
import { createModelRepo } from "./repo/models";

/**
 * 自动快照与导出目录（M2 Task 8）
 *
 * 快照是派生物：只单向 DB → YAML（<configDir>/export/latest.yaml），
 * 永不反向影响库；失败只 warn 不抛——备份不能阻塞主流程。
 *
 * 快照钩子（T8 时点）：models POST/PUT/DELETE、namespaces POST/PATCH/DELETE、
 * models/:name/move、settings default 变更、import / migrate/bash 路由尾部；
 * T8 之后新增的配置变更路由也要在尾部调 maybeAutoSnapshot（设计文档要求）。
 *
 * 调用方式取舍：同步调用（非 fire-and-forget）——写盘毫秒级量级，同步最简单
 * 且保证「响应返回时快照已落盘」，避免丢更新窗口。
 */

/** settings 表中自动快照开关的键（缺省 = 开；"0"/"false" 关，其他值视为开） */
export const AUTO_SNAPSHOT_KEY = "auto_snapshot";

/** 导出目录 = panel.yaml 同级的 export/（与 config/ 目录的定位规则一致） */
export function getExportDir(): string {
  return path.join(path.dirname(getConfigPath()), "export");
}

/** 读 settings.auto_snapshot：未记录视为开 */
export function isAutoSnapshotEnabled(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(AUTO_SNAPSHOT_KEY) as { value: string } | undefined;
  return !(row?.value === "0" || row?.value === "false");
}

/** 库内全量配置 → 导出 YAML 文本（defaults + models + namespaces 三段） */
export function buildExportYaml(db: Database.Database): string {
  const repo = createModelRepo(db);
  return toExportYaml({
    defaults: repo.getDefaultConfig(),
    models: repo.listModels(),
    namespaces: repo.listNamespaces(),
  });
}

/**
 * 配置变更后的自动快照：开启则把全量配置写入 export/latest.yaml。
 * @returns 是否实际写盘（关闭或失败均为 false；失败仅 console.warn）
 */
export function maybeAutoSnapshot(db: Database.Database): boolean {
  if (!isAutoSnapshotEnabled(db)) return false;
  try {
    const yaml = buildExportYaml(db);
    const dir = getExportDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "latest.yaml"), yaml, "utf8");
    return true;
  } catch (error) {
    // 备份失败绝不阻塞主流程：只 warn，下次变更会再尝试
    console.warn("自动快照失败（不影响本次操作）:", error instanceof Error ? error.message : error);
    return false;
  }
}
