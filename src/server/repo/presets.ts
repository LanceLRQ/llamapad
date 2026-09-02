import type Database from "better-sqlite3";

import { partialServerConfigSchema, type ServerConfig } from "../../core/schemas";

/**
 * 参数预设仓储（参数预设子系统）
 *
 * 预设 = 一组有名字的 `Partial<ServerConfig>`，**不绑模型、不绑文件**，
 * 建配置时可选择套用。应用语义是**快照**：选中时把值拷进 model.overrides，
 * 之后两者再无关系——引用式会把现在的两层合并（default ⊕ overrides）变成三层，
 * 代价远大于收益（设计 §8.3）。
 *
 * 内置三档不在这张表里（见迁移 v14 注释与 lib/param-presets.ts）。
 *
 * 命名注意：面板里「另存为新模板」指的是**克隆一份模型配置**
 * （app/(panel)/models/[name]/duplicate），与本模块无关，不要混。
 */

/** 预设名长度上限：够描述用途，又不至于把下拉撑爆 */
const MAX_NAME = 64;

export type PresetErrorCode = "INVALID_NAME" | "NOT_FOUND" | "CONFLICT";

export class PresetError extends Error {
  constructor(
    readonly code: PresetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PresetError";
  }
}

/** 错误码 → HTTP 状态，与 repoProfiles.ts 的既有契约一致 */
export function presetErrorStatus(code: PresetErrorCode): number {
  if (code === "NOT_FOUND") return 404;
  if (code === "CONFLICT") return 409;
  return 400;
}

export type PresetSource = "manual" | "readme" | "model";

export interface ParamPreset {
  id: number;
  name: string;
  description: string | null;
  server: Partial<ServerConfig>;
  source: PresetSource;
  /** source="readme" 时记来源仓库，可回溯出处 */
  sourceRepo: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreatePresetArgs {
  name: string;
  description?: string | null;
  server: Partial<ServerConfig>;
  source?: PresetSource;
  sourceRepo?: string | null;
}

/**
 * 预设的 server 段 = serverConfigSchema 的 strict partial（含 reasoning_effort
 * 的 zod 4 .default() 实体化陷阱绕法，与 core/schemas.ts 的 overridesSchema、
 * core/yamlIo.ts 的 paramPresetExportSchema 同源，已收敛成共享构造式，见
 * partialServerConfigSchema 定义处的注释）。
 */
const presetServerSchema = partialServerConfigSchema;

interface Row {
  id: number;
  name: string;
  description: string | null;
  server: string;
  source: string;
  source_repo: string | null;
  created_at: number;
  updated_at: number;
}

function toPreset(row: Row): ParamPreset {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    server: JSON.parse(row.server) as Partial<ServerConfig>,
    source: row.source as PresetSource,
    sourceRepo: row.source_repo,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeName(raw: string): string {
  const name = raw.trim();
  if (name === "") throw new PresetError("INVALID_NAME", "INVALID_NAME: 预设名不能为空");
  if (name.length > MAX_NAME) {
    throw new PresetError("INVALID_NAME", `INVALID_NAME: 预设名超过 ${MAX_NAME} 字`);
  }
  return name;
}

/** 校验 + 序列化 server 段；空对象拒绝——不含任何参数的预设套上去什么都不会发生 */
function serializeServer(server: Partial<ServerConfig>): string {
  const parsed = presetServerSchema.safeParse(server);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`预设参数校验失败: ${detail}`);
  }
  if (Object.keys(parsed.data).length === 0) {
    throw new PresetError("INVALID_NAME", "INVALID_NAME: 预设至少要含一个参数");
  }
  return JSON.stringify(parsed.data);
}

export function listPresets(db: Database.Database): ParamPreset[] {
  const rows = db.prepare("SELECT * FROM param_presets ORDER BY name").all() as Row[];
  return rows.map(toPreset);
}

export function getPreset(db: Database.Database, id: number): ParamPreset | null {
  const row = db.prepare("SELECT * FROM param_presets WHERE id = ?").get(id) as Row | undefined;
  return row === undefined ? null : toPreset(row);
}

export function createPreset(db: Database.Database, args: CreatePresetArgs): ParamPreset {
  const name = normalizeName(args.name);
  const server = serializeServer(args.server);

  const dup = db.prepare("SELECT id FROM param_presets WHERE name = ?").get(name);
  if (dup !== undefined) throw new PresetError("CONFLICT", `CONFLICT: 预设名已存在: ${name}`);

  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO param_presets(name, description, server, source, source_repo, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(name, args.description ?? null, server, args.source ?? "manual", args.sourceRepo ?? null, now, now);

  return getPreset(db, Number(info.lastInsertRowid))!;
}

export interface UpdatePresetArgs {
  name?: string;
  description?: string | null;
  server?: Partial<ServerConfig>;
}

export function updatePreset(
  db: Database.Database,
  id: number,
  args: UpdatePresetArgs,
): ParamPreset {
  const current = getPreset(db, id);
  if (current === null) throw new PresetError("NOT_FOUND", `NOT_FOUND: 预设不存在: ${id}`);

  const name = args.name === undefined ? current.name : normalizeName(args.name);
  if (name !== current.name) {
    const dup = db.prepare("SELECT id FROM param_presets WHERE name = ?").get(name);
    if (dup !== undefined) throw new PresetError("CONFLICT", `CONFLICT: 预设名已存在: ${name}`);
  }
  const server = args.server === undefined ? JSON.stringify(current.server) : serializeServer(args.server);
  const description = args.description === undefined ? current.description : args.description;

  db.prepare(
    "UPDATE param_presets SET name = ?, description = ?, server = ?, updated_at = ? WHERE id = ?",
  ).run(name, description, server, Date.now(), id);

  return getPreset(db, id)!;
}

export function deletePreset(db: Database.Database, id: number): void {
  const info = db.prepare("DELETE FROM param_presets WHERE id = ?").run(id);
  if (info.changes === 0) throw new PresetError("NOT_FOUND", `NOT_FOUND: 预设不存在: ${id}`);
}
