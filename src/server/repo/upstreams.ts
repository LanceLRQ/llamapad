import type Database from "better-sqlite3";

import { normalizeAliases, type UpstreamAlias, type UpstreamAliasInput } from "../../lib/upstream-alias";
import { apiKeyProblem, normalizeUpstreamBaseUrl, upstreamNameProblem } from "../../lib/upstream-url";

/**
 * 外部上游仓储：不由面板启停的 OpenAI 兼容服务的登记表。
 *
 * name 是中转请求里的 model 值，与托管模型共用一个命名空间，写入时在这里检查
 * models 表（另一个方向的检查在 repo/models.ts 的 createModel）。name 不支持修改：
 * 它是主键，也是客户端写死的模型名，要换名字就删除重建。
 *
 * 别名（upstream_aliases）与上游一起读写：它们是中转请求里 model 的另一种写法，
 * 与托管模型名、上游名称、其他上游的别名全局唯一（同一个名字只能指向一个目标）。
 *
 * 本模块返回的 StoredUpstream 带明文 apiKey，只在服务端内部流转；出接口前必须
 * 经 server/upstreams/view.ts 的 toUpstreamView 转成不含明文的视图。
 */

/** settings 表里默认上游的键 */
const DEFAULT_UPSTREAM_KEY = "default_upstream";

export type UpstreamErrorCode = "INVALID" | "NOT_FOUND" | "CONFLICT";

export class UpstreamError extends Error {
  constructor(
    readonly code: UpstreamErrorCode,
    message: string,
    /** INVALID 时指出是哪个字段，接口据此给出字段级提示 */
    readonly field?: string,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

export function upstreamErrorStatus(code: UpstreamErrorCode): number {
  if (code === "NOT_FOUND") return 404;
  if (code === "CONFLICT") return 409;
  return 400;
}

export interface StoredUpstream {
  name: string;
  displayName: string;
  baseUrl: string;
  apiKey: string | null;
  upstreamModel: string | null;
  enabled: boolean;
  note: string | null;
  /** 按 position 升序 */
  aliases: UpstreamAlias[];
  createdAt: number;
  updatedAt: number;
}

export interface CreateUpstreamArgs {
  name: string;
  displayName: string;
  baseUrl: string;
  apiKey?: string | null;
  upstreamModel?: string | null;
  enabled?: boolean;
  note?: string | null;
  /** 缺席 = 没有别名 */
  aliases?: UpstreamAliasInput[];
}

/** 字段缺席（undefined）= 不改。apiKey 传空串或 null = 清除 */
export interface UpdateUpstreamArgs {
  displayName?: string;
  baseUrl?: string;
  apiKey?: string | null;
  upstreamModel?: string | null;
  enabled?: boolean;
  note?: string | null;
  /** 缺席 = 不改；给了 = 整表替换（空数组 = 清空） */
  aliases?: UpstreamAliasInput[];
}

interface Row {
  name: string;
  display_name: string;
  base_url: string;
  api_key: string | null;
  upstream_model: string | null;
  enabled: number;
  note: string | null;
  created_at: number;
  updated_at: number;
}

interface AliasRow {
  alias: string;
  upstream: string;
  upstream_model: string | null;
}

/** 中转路由装配用：一个别名及其所属上游 */
export interface AliasRoute {
  alias: string;
  upstream: string;
  upstreamModel: string | null;
}

function toStored(row: Row, aliases: UpstreamAlias[]): StoredUpstream {
  return {
    name: row.name,
    displayName: row.display_name,
    baseUrl: row.base_url,
    apiKey: row.api_key,
    upstreamModel: row.upstream_model,
    enabled: row.enabled === 1,
    note: row.note,
    aliases,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 可选文本字段：去首尾空白，空串归 null */
function optionalText(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/** 密钥：去首尾空白，空串归 null，非空须是可见 ASCII */
function optionalApiKey(value: string | null | undefined): string | null {
  const key = optionalText(value);
  if (key !== null && apiKeyProblem(key) !== null) {
    throw new UpstreamError("INVALID", "INVALID: API 密钥只能包含可见的 ASCII 字符，不能有空白或换行", "apiKey");
  }
  return key;
}

function requireDisplayName(raw: string): string {
  const value = raw.trim();
  if (value === "") throw new UpstreamError("INVALID", "INVALID: 展示名不能为空", "displayName");
  return value;
}

function requireBaseUrl(raw: string): string {
  const result = normalizeUpstreamBaseUrl(raw);
  if (!result.ok) {
    const detail = result.reason === "protocol" ? "只支持 http 或 https" : "不是合法的地址";
    throw new UpstreamError("INVALID", `INVALID: 上游地址${detail}`, "baseUrl");
  }
  return result.url;
}

function toAlias(row: AliasRow): UpstreamAlias {
  return { alias: row.alias, upstreamModel: row.upstream_model };
}

export function listUpstreams(db: Database.Database): StoredUpstream[] {
  const grouped = new Map<string, UpstreamAlias[]>();
  const aliasRows = db
    .prepare("SELECT alias, upstream, upstream_model FROM upstream_aliases ORDER BY upstream, position")
    .all() as AliasRow[];
  for (const row of aliasRows) {
    const list = grouped.get(row.upstream);
    if (list === undefined) grouped.set(row.upstream, [toAlias(row)]);
    else list.push(toAlias(row));
  }
  return (db.prepare("SELECT * FROM upstreams ORDER BY name").all() as Row[]).map((row) =>
    toStored(row, grouped.get(row.name) ?? []),
  );
}

export function getUpstream(db: Database.Database, name: string): StoredUpstream | null {
  const row = db.prepare("SELECT * FROM upstreams WHERE name = ?").get(name) as Row | undefined;
  if (row === undefined) return null;
  const aliasRows = db
    .prepare("SELECT alias, upstream, upstream_model FROM upstream_aliases WHERE upstream = ? ORDER BY position")
    .all(name) as AliasRow[];
  return toStored(row, aliasRows.map(toAlias));
}

/** 全部别名及其所属上游，一次查询；给中转路由装配用 */
export function listAliasRoutes(db: Database.Database): AliasRoute[] {
  const rows = db
    .prepare("SELECT alias, upstream, upstream_model FROM upstream_aliases ORDER BY upstream, position")
    .all() as AliasRow[];
  return rows.map((row) => ({ alias: row.alias, upstream: row.upstream, upstreamModel: row.upstream_model }));
}

const ALIAS_PROBLEM_TEXT = {
  format: "只允许字母、数字与 . _ : / -，且不能以符号开头",
  length: "最长 128 个字符",
  targetLength: "上游模型名最长 256 个字符",
  duplicate: "同一上游下别名不能重复",
  ownerName: "不能与所属上游的名称相同",
  tooMany: "每个上游最多 50 个别名",
} as const;

/** 规范化并校验别名输入，失败抛 INVALID（field 指到 aliases.<下标>.<字段> 或 aliases） */
function requireAliases(inputs: UpstreamAliasInput[], upstreamName: string): UpstreamAlias[] {
  const result = normalizeAliases(inputs, upstreamName);
  if (result.ok) return result.aliases;
  if (result.index === null) {
    throw new UpstreamError("INVALID", `INVALID: ${ALIAS_PROBLEM_TEXT[result.reason]}`, "aliases");
  }
  const subject = result.field === "upstreamModel" ? "" : `别名 ${inputs[result.index].alias}：`;
  throw new UpstreamError(
    "INVALID",
    `INVALID: ${subject}${ALIAS_PROBLEM_TEXT[result.reason]}`,
    `aliases.${result.index}.${result.field}`,
  );
}

/** 别名不得撞上托管模型名、任何上游名称、其他上游的别名（owner 自己原有的别名不算） */
function assertAliasesFree(db: Database.Database, owner: string, aliases: UpstreamAlias[]): void {
  const isModel = db.prepare("SELECT 1 FROM models WHERE name = ?");
  const isUpstream = db.prepare("SELECT 1 FROM upstreams WHERE name = ?");
  const heldByOther = db.prepare("SELECT 1 FROM upstream_aliases WHERE alias = ? AND upstream <> ?");
  aliases.forEach(({ alias }, index) => {
    const taken =
      isModel.get(alias) !== undefined
        ? "已有同名的模型配置"
        : isUpstream.get(alias) !== undefined
          ? "已有同名的上游"
          : heldByOther.get(alias, owner) !== undefined
            ? "已被其他上游用作别名"
            : null;
    if (taken !== null) throw new UpstreamError("CONFLICT", `CONFLICT: ${taken}: ${alias}`, `aliases.${index}.alias`);
  });
}

/** 整表替换：先删后按顺序写入，position 即数组下标 */
function replaceAliases(db: Database.Database, owner: string, aliases: UpstreamAlias[]): void {
  db.prepare("DELETE FROM upstream_aliases WHERE upstream = ?").run(owner);
  const insert = db.prepare("INSERT INTO upstream_aliases(alias, upstream, upstream_model, position) VALUES (?, ?, ?, ?)");
  aliases.forEach((item, position) => insert.run(item.alias, owner, item.upstreamModel, position));
}

export function createUpstream(db: Database.Database, args: CreateUpstreamArgs): StoredUpstream {
  const problem = upstreamNameProblem(args.name);
  if (problem === "format") {
    throw new UpstreamError("INVALID", "INVALID: 名字只允许小写字母、数字与连字符，且不能以连字符开头", "name");
  }
  if (problem === "reserved") throw new UpstreamError("INVALID", `INVALID: ${args.name} 是保留名`, "name");
  const displayName = requireDisplayName(args.displayName);
  const baseUrl = requireBaseUrl(args.baseUrl);
  const apiKey = optionalApiKey(args.apiKey);
  const aliases = requireAliases(args.aliases ?? [], args.name);

  const write = db.transaction(() => {
    if (db.prepare("SELECT 1 FROM models WHERE name = ?").get(args.name) !== undefined) {
      throw new UpstreamError("CONFLICT", `CONFLICT: 已有同名的模型配置: ${args.name}`, "name");
    }
    if (db.prepare("SELECT 1 FROM upstream_aliases WHERE alias = ?").get(args.name) !== undefined) {
      throw new UpstreamError("CONFLICT", `CONFLICT: 已有同名的别名: ${args.name}`, "name");
    }
    if (getUpstream(db, args.name) !== null) {
      throw new UpstreamError("CONFLICT", `CONFLICT: 上游已存在: ${args.name}`, "name");
    }
    assertAliasesFree(db, args.name, aliases);

    const now = Date.now();
    db.prepare(
      `INSERT INTO upstreams(name, display_name, base_url, api_key, upstream_model, enabled, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      args.name,
      displayName,
      baseUrl,
      apiKey,
      optionalText(args.upstreamModel),
      args.enabled === false ? 0 : 1,
      optionalText(args.note),
      now,
      now,
    );
    replaceAliases(db, args.name, aliases);
  });
  write();
  return getUpstream(db, args.name)!;
}

export function updateUpstream(db: Database.Database, name: string, args: UpdateUpstreamArgs): StoredUpstream {
  const current = getUpstream(db, name);
  if (current === null) throw new UpstreamError("NOT_FOUND", `NOT_FOUND: 上游不存在: ${name}`);

  const next = {
    displayName: args.displayName === undefined ? current.displayName : requireDisplayName(args.displayName),
    baseUrl: args.baseUrl === undefined ? current.baseUrl : requireBaseUrl(args.baseUrl),
    apiKey: args.apiKey === undefined ? current.apiKey : optionalApiKey(args.apiKey),
    upstreamModel: args.upstreamModel === undefined ? current.upstreamModel : optionalText(args.upstreamModel),
    enabled: args.enabled === undefined ? current.enabled : args.enabled,
    note: args.note === undefined ? current.note : optionalText(args.note),
  };
  const aliases = args.aliases === undefined ? undefined : requireAliases(args.aliases, name);

  const write = db.transaction(() => {
    if (aliases !== undefined) assertAliasesFree(db, name, aliases);
    db.prepare(
      `UPDATE upstreams
       SET display_name = ?, base_url = ?, api_key = ?, upstream_model = ?, enabled = ?, note = ?, updated_at = ?
       WHERE name = ?`,
    ).run(next.displayName, next.baseUrl, next.apiKey, next.upstreamModel, next.enabled ? 1 : 0, next.note, Date.now(), name);
    if (aliases !== undefined) replaceAliases(db, name, aliases);
  });
  write();
  return getUpstream(db, name)!;
}

export function deleteUpstream(db: Database.Database, name: string): void {
  db.transaction(() => {
    // 显式删别名，外键级联只当兜底
    db.prepare("DELETE FROM upstream_aliases WHERE upstream = ?").run(name);
    const info = db.prepare("DELETE FROM upstreams WHERE name = ?").run(name);
    if (info.changes === 0) throw new UpstreamError("NOT_FOUND", `NOT_FOUND: 上游不存在: ${name}`);
    db.prepare("DELETE FROM settings WHERE key = ? AND value = ?").run(DEFAULT_UPSTREAM_KEY, name);
  })();
}

/**
 * 读默认上游名。指向的上游已不存在（手工改库等脏数据）时当作未设置并顺手删掉该键，
 * 免得每次决议都带着一条无效记录。停用的上游仍然返回——停用只是暂时让出默认，
 * 重新启用后要恢复，是否生效由路由决议判断。
 */
export function getDefaultUpstream(db: Database.Database): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(DEFAULT_UPSTREAM_KEY) as
    | { value: string }
    | undefined;
  if (row === undefined) return null;
  if (getUpstream(db, row.value) === null) {
    clearDefaultUpstream(db);
    return null;
  }
  return row.value;
}

export function setDefaultUpstream(db: Database.Database, name: string): void {
  if (getUpstream(db, name) === null) throw new UpstreamError("NOT_FOUND", `NOT_FOUND: 上游不存在: ${name}`);
  db.prepare(
    "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(DEFAULT_UPSTREAM_KEY, name);
}

export function clearDefaultUpstream(db: Database.Database): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(DEFAULT_UPSTREAM_KEY);
}

/**
 * 「默认上游已设置且处于启用状态」时返回它的名字，否则 null。只看库，不看存活状态：
 * 模型页据此决定要不要给托管模型显示「默认」标记（见 modelsView.ts）。
 */
export function getActiveDefaultUpstream(db: Database.Database): string | null {
  const name = getDefaultUpstream(db);
  if (name === null) return null;
  return getUpstream(db, name)?.enabled ? name : null;
}
