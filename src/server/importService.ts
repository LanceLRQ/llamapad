import type Database from "better-sqlite3";
import {
  applyImportConflict,
  type ImportStrategy,
  type ParamPresetExport,
  type RepoProfileExport,
} from "@/core/yamlIo";
import { ggufPathSchema, type DefaultConfig, type ModelConfig } from "@/core/schemas";
import { isValidBaseDir, isValidRepoId, repoTargetDir } from "@/lib/repo-path";
import { MAX_DIR_DEPTH } from "./fsScanner";
import { createModelRepo } from "./repo/models";
import { createPreset, listPresets } from "./repo/presets";
import { createProfile, RepoProfileError } from "./repoProfiles";

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
 * - importRepos（I8 修复）：快照的 repos 段此前写出来无人读，恢复时档案
 *   登记全部丢失，磁盘目录变孤儿。逐条复用 repoProfiles.createProfile
 *   落库，已登记的 (baseDir, repo) 降级为跳过，不让整次导入失败
 * - importPresets（参数预设子系统）：预设是用户资产，快照不带会让「从 YAML
 *   恢复」静默丢光；同名跳过不覆盖，单条坏数据进 failed 不阻断整批
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

export interface ImportReposOutcome {
  /** 新登记（新建或认领）的档案，用 targetDir 标识 */
  imported: string[];
  /** 已登记的同 (baseDir, repo) 组合，跳过不算失败，用 targetDir 标识 */
  skipped: string[];
}

/**
 * 按快照恢复仓库档案（I8 修复）：逐条复用 repoProfiles.createProfile——
 * 目录创建、标记文件、targetDir 推导、CONFLICT 判定都在它里面，这里不另写
 * 一份插表逻辑。`runningModel` 传 null：createProfile 只解构
 * `{ db, modelsRoot }`，运行中模型只与删除/移动的 LOCKED 判定有关，新建/
 * 认领用不到。YAML 里的 id / createdAt 不恢复（yamlIo.ts 的
 * RepoProfileExport 注释已说明二者是本地自增/元数据，跨机无意义）。
 *
 * 已登记的 (baseDir, repo) 会抛 CONFLICT——按「跳过」处理，不让整次导入
 * 失败：换机恢复时，用户可能已经手动重建过部分档案。
 *
 * 前置校验（缺陷 3 修复）：`exportBundleSchema` 对 `repos[].repo` 只有
 * `min(1)`，含空格这类非法仓库名能通过 zod、只有到 createProfile 的
 * isValidRepoId 才被拒——若逐条落库中途才发现，前面几条已经 mkdirSync
 * 建好目录、标记文件已写、DB 行已插入，用户看到"导入失败"后重试还会按
 * strategy 再走一遍冲突处置。故在任何落盘之前先整体遍历一遍 repos，
 * 校验口径与 createProfile 一致（isValidRepoId / isValidBaseDir / 落盘
 * 目录深度上限），任一不合法立即抛，此时尚未创建任何目录、未写任何标记
 * 文件、未插任何行。校验通过后才进入原有的逐条 createProfile 循环
 * （CONFLICT 仍按"跳过"处理，这条既有行为不变）。
 */
export function importRepos(
  db: Database.Database,
  modelsRoot: string,
  repos: RepoProfileExport[],
): ImportReposOutcome {
  for (const r of repos) {
    if (!isValidRepoId(r.repo)) {
      throw new RepoProfileError("INVALID_NAME", `INVALID_NAME: 仓库 ID 非法: ${r.repo}`);
    }
    if (!isValidBaseDir(r.baseDir)) {
      throw new RepoProfileError("INVALID_NAME", `INVALID_NAME: 存放目录非法: ${r.baseDir}`);
    }
    const dir = repoTargetDir(r.baseDir, r.repo);
    if (dir.split("/").length > MAX_DIR_DEPTH) {
      throw new RepoProfileError(
        "INVALID_NAME",
        `INVALID_NAME: 落盘目录层级超过上限（${MAX_DIR_DEPTH} 层）: ${dir}`,
      );
    }
  }

  const outcome: ImportReposOutcome = { imported: [], skipped: [] };
  for (const r of repos) {
    try {
      const created = createProfile(
        { db, modelsRoot, runningModel: null },
        { repo: r.repo, baseDir: r.baseDir },
      );
      outcome.imported.push(created.targetDir);
    } catch (error) {
      if (error instanceof RepoProfileError && error.code === "CONFLICT") {
        outcome.skipped.push(repoTargetDir(r.baseDir, r.repo));
        continue;
      }
      throw error;
    }
  }
  return outcome;
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

export interface ImportPresetsOutcome {
  created: string[];
  /** 同名已存在，跳过（不覆盖） */
  skipped: string[];
  failed: { name: string; error: string }[];
}

/**
 * 导入参数预设：**同名跳过，不覆盖**——与档案导入的 CONFLICT 语义一致，
 * 导入不该悄悄改掉用户已有的东西。单条失败不阻断整批（一份手改过的 YAML 里
 * 有一条坏预设，不该让其余全都进不来）。
 */
export function importPresets(
  db: Database.Database,
  presets: ParamPresetExport[] | undefined,
): ImportPresetsOutcome {
  const outcome: ImportPresetsOutcome = { created: [], skipped: [], failed: [] };
  if (presets === undefined || presets.length === 0) return outcome;

  const existing = new Set(listPresets(db).map((p) => p.name));
  for (const preset of presets) {
    if (existing.has(preset.name)) {
      outcome.skipped.push(preset.name);
      continue;
    }
    try {
      createPreset(db, {
        name: preset.name,
        description: preset.description ?? null,
        server: preset.server,
      });
      existing.add(preset.name);
      outcome.created.push(preset.name);
    } catch (error) {
      outcome.failed.push({
        name: preset.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcome;
}
