import type Database from "better-sqlite3";
import { applyImportConflict, type ImportStrategy } from "@/core/yamlIo";
import type { DefaultConfig, ModelConfig } from "@/core/schemas";
import { createModelRepo } from "./repo/models";

/**
 * 导入落库服务（M2 Task 8）：/api/v1/import 与 /api/v1/migrate/bash 共用。
 *
 * 职责（路由层只负责 body 校验与 YAML 解析）：
 * - 模型缺失的命名空间自动补建（createNamespace 幂等）
 * - 执行 applyImportConflict 的三策略结果：skip 跳过 / rename 改名新建 /
 *   overwrite 走 updateModel 覆盖全部可编辑字段
 * - 批内重名（畸形导入源）：首个为准，后续丢弃并 warning
 * - applyDefaults：默认配置写入（repo.setDefaultConfig 同款校验，错误带字段路径）
 */

export interface ImportOutcome {
  /** 成功落库的名字（rename 后为新名） */
  imported: string[];
  /** 冲突跳过的名字（strategy=skip） */
  skipped: string[];
  /** rename 的改名记录 */
  renamed: { from: string; to: string }[];
  /** 覆盖的名字（strategy=overwrite） */
  overwritten: string[];
  /** 解析期 + 落库期的非致命警告（致命错误直接抛） */
  warnings: string[];
}

/** 写入默认配置；schema 不符抛 message 带字段路径的 Error（由路由转 400） */
export function applyDefaults(db: Database.Database, defaults: DefaultConfig): void {
  createModelRepo(db).setDefaultConfig(defaults);
}

/**
 * 按冲突策略把模型批量落库。单个模型校验失败（如库内命名空间规则外的问题）
 * 直接抛出终止整批——导入应保持原子语义的简单版：要么前置 YAML 校验全过，
 * 要么报错让用户修文件；半成功半失败的状态最难排查。
 */
export function importModels(
  db: Database.Database,
  models: ModelConfig[],
  strategy: ImportStrategy,
): ImportOutcome {
  const repo = createModelRepo(db);
  const outcome: ImportOutcome = { imported: [], skipped: [], renamed: [], overwritten: [], warnings: [] };

  // 批内重名去重（首个为准）：applyImportConflict 的 Map<old,new> 无法表达同名多份
  const unique: ModelConfig[] = [];
  const seen = new Set<string>();
  for (const m of models) {
    if (seen.has(m.name)) {
      outcome.warnings.push(`导入内容中模型 ${m.name} 重复，仅保留第一份`);
      continue;
    }
    seen.add(m.name);
    unique.push(m);
  }

  // 缺失命名空间自动补建（幂等；名非法由 createNamespace 抛错带信息）
  for (const ns of new Set(unique.map((m) => m.namespace))) {
    repo.createNamespace(ns);
  }

  const existing = repo.listModels().map((m) => m.name);
  const conflicts = applyImportConflict(
    existing,
    unique.map((m) => m.name),
    strategy,
  );

  for (const m of unique) {
    if (conflicts.skip.includes(m.name)) {
      outcome.skipped.push(m.name);
      continue;
    }
    if (conflicts.renamed.has(m.name)) {
      const to = conflicts.renamed.get(m.name)!;
      repo.createModel({ ...m, name: to });
      outcome.renamed.push({ from: m.name, to });
      outcome.imported.push(to);
      continue;
    }
    if (conflicts.overwritten.includes(m.name)) {
      // 覆盖全部可编辑字段（name 为主键不可改，也无需改）
      repo.updateModel(m.name, {
        display_name: m.display_name,
        namespace: m.namespace,
        gguf_file: m.gguf_file,
        mmproj_file: m.mmproj_file ?? null,
        download: m.download ?? null,
        overrides: m.overrides,
      });
      outcome.overwritten.push(m.name);
      outcome.imported.push(m.name);
      continue;
    }
    repo.createModel(m);
    outcome.imported.push(m.name);
  }
  return outcome;
}
