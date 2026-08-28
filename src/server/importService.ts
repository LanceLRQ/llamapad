import type Database from "better-sqlite3";
import { applyImportConflict, type ImportStrategy } from "@/core/yamlIo";
import { ggufPathSchema, type DefaultConfig, type ModelConfig } from "@/core/schemas";
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
 * - 导入重指（T4，规格 §4）：remap 按原始模型名替换 gguf_file/mmproj_file，
 *   在冲突处置之前套用——重指只改文件路径，不影响 skip/rename/overwrite 判断
 */

/** 导入重指：key = YAML 中的模型名，值为要写入的新路径（未列出的字段保留原值） */
export type ImportRemap = Record<string, { gguf_file?: string; mmproj_file?: string }>;

/**
 * zod 校验失败 → message 带字段路径的 Error。ggufPathSchema 校验的是裸字符串，
 * issue.path 恒为空，不套用 repo/models.ts `invalid()` 那种 issue.path 拼接
 * 写法（拼出来是空字符串，徒留多余的冒号）——字段路径直接由调用方传入。
 */
function invalidRemapValue(fieldPath: string, issues: { message: string }[]): never {
  throw new Error(`${fieldPath}: ${issues.map((i) => i.message).join("; ")}`);
}

/**
 * 按模型名把 remap 套用到解析结果上（纯函数，不碰库）。remap 指向的模型名
 * 若不在待导入列表中——多半是预检和提交之间用户又改了 YAML 内容——按语义
 * 静默忽略：warnings 语义是"YAML 内容本身的问题"，这是请求形状与内容对不上，
 * 不值得占一条用户可见的警告。
 */
export function applyRemap(models: ModelConfig[], remap: ImportRemap): ModelConfig[] {
  return models.map((m) => {
    const entry = remap[m.name];
    if (!entry) return m;
    const next = { ...m };
    if (entry.gguf_file !== undefined) {
      const parsed = ggufPathSchema.safeParse(entry.gguf_file);
      if (!parsed.success) invalidRemapValue(`remap.${m.name}.gguf_file`, parsed.error.issues);
      next.gguf_file = parsed.data;
    }
    if (entry.mmproj_file !== undefined) {
      const parsed = ggufPathSchema.safeParse(entry.mmproj_file);
      if (!parsed.success) invalidRemapValue(`remap.${m.name}.mmproj_file`, parsed.error.issues);
      next.mmproj_file = parsed.data;
    }
    return next;
  });
}

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
  remap?: ImportRemap,
): ImportOutcome {
  const repo = createModelRepo(db);
  const outcome: ImportOutcome = { imported: [], skipped: [], renamed: [], overwritten: [], warnings: [] };

  // remap 按原始模型名套用（未传时 source 与 models 是同一份引用，行为逐字不变）
  const source = remap ? applyRemap(models, remap) : models;

  // 批内重名去重（首个为准）：applyImportConflict 的 Map<old,new> 无法表达同名多份
  const unique: ModelConfig[] = [];
  const seen = new Set<string>();
  for (const m of source) {
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
