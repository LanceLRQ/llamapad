import {
  ALIAS_TARGET_MAX_LENGTH,
  MAX_ALIASES_PER_UPSTREAM,
  aliasProblem,
  type AliasProblemReason,
} from "./upstream-alias";
import type { UpstreamView } from "./upstream-types";
import { apiKeyProblem, normalizeUpstreamBaseUrl, upstreamNameProblem } from "./upstream-url";

/**
 * 外部上游表单的草稿与请求体构造（纯函数，弹窗组件只负责渲染与发请求）。
 *
 * 密钥在编辑时的三种意图要分清：输入框留空 = 不改（服务端也不会把已保存的明文发回来）；
 * 输入了新值 = 替换；勾了「清除密钥」= 清除。
 */

export interface UpstreamDraft {
  name: string;
  displayName: string;
  baseUrl: string;
  /** 新建时是要保存的密钥；编辑时是「新密钥」，留空表示不改 */
  apiKey: string;
  /** 仅编辑时有意义 */
  clearApiKey: boolean;
  upstreamModel: string;
  note: string;
  /** 别名行；目标用字符串，空串表示留空 */
  aliases: { alias: string; upstreamModel: string }[];
}

export type DraftMode = "create" | "edit";

export function emptyDraft(): UpstreamDraft {
  return { name: "", displayName: "", baseUrl: "", apiKey: "", clearApiKey: false, upstreamModel: "", note: "", aliases: [] };
}

export function draftFromView(view: UpstreamView): UpstreamDraft {
  return {
    name: view.name,
    displayName: view.displayName,
    baseUrl: view.baseUrl,
    apiKey: "",
    clearApiKey: false,
    upstreamModel: view.upstreamModel ?? "",
    note: view.note ?? "",
    aliases: view.aliases.map((a) => ({ alias: a.alias, upstreamModel: a.upstreamModel ?? "" })),
  };
}

export type DraftProblem = "name" | "nameReserved" | "displayName" | "baseUrl" | "apiKey" | "aliases";

/** 有字段级提示位的问题（aliases 逐行显示，不在其中） */
export type FieldProblem = Exclude<DraftProblem, "aliases">;

/** 有字段级提示位的表单字段；别名的问题逐行显示在别名行下，不在这里 */
export type DraftField = "name" | "displayName" | "baseUrl" | "apiKey";

/** 填了密钥（trim 后非空）但含空格 / 换行 / 非 ASCII 可见字符 */
export function apiKeyDraftInvalid(draft: UpstreamDraft): boolean {
  const key = draft.apiKey.trim();
  return key !== "" && apiKeyProblem(key) !== null;
}

/** 某一行（或整组，index 为 null）别名的问题 */
export interface AliasRowProblem {
  index: number | null;
  field: "alias" | "upstreamModel" | "group";
  reason: AliasProblemReason;
}

/** 整行（别名与目标）都是空白的行视为未填 */
function aliasRowBlank(row: { alias: string; upstreamModel: string }): boolean {
  return row.alias.trim() === "" && row.upstreamModel.trim() === "";
}

/**
 * 逐行找出别名的问题，index 对应 draft.aliases 的下标。别名先 trim 再判定；
 * 空行忽略。每行最多报一个问题（别名优先于目标）。服务端仍会再校验一遍
 */
export function aliasProblems(draft: UpstreamDraft): AliasRowProblem[] {
  const problems: AliasRowProblem[] = [];
  const seen = new Set<string>();
  let filled = 0;
  draft.aliases.forEach((row, index) => {
    if (aliasRowBlank(row)) return;
    filled++;
    const alias = row.alias.trim();
    const problem = aliasProblem(alias);
    if (problem !== null) {
      problems.push({ index, field: "alias", reason: problem });
      return;
    }
    if (alias === draft.name) {
      problems.push({ index, field: "alias", reason: "ownerName" });
      return;
    }
    if (seen.has(alias)) {
      problems.push({ index, field: "alias", reason: "duplicate" });
      return;
    }
    seen.add(alias);
    if (row.upstreamModel.trim().length > ALIAS_TARGET_MAX_LENGTH) {
      problems.push({ index, field: "upstreamModel", reason: "targetLength" });
    }
  });
  if (filled > MAX_ALIASES_PER_UPSTREAM) problems.push({ index: null, field: "group", reason: "tooMany" });
  return problems;
}

/** 第一个有问题的字段；都合法返回 null。服务端仍会再校验一遍，这里只为了即时提示 */
export function draftProblem(draft: UpstreamDraft, mode: DraftMode): DraftProblem | null {
  if (mode === "create") {
    const problem = upstreamNameProblem(draft.name);
    if (problem === "format") return "name";
    if (problem === "reserved") return "nameReserved";
  }
  if (draft.displayName.trim() === "") return "displayName";
  if (!normalizeUpstreamBaseUrl(draft.baseUrl).ok) return "baseUrl";
  if (apiKeyDraftInvalid(draft)) return "apiKey";
  if (aliasProblems(draft).length > 0) return "aliases";
  return null;
}

/**
 * 各字段此刻该显示的问题（提示贴在对应输入框下）。空值不算「写错」：名称为空永远不报
 * （保存按钮禁用已足够），展示名与地址为空要等用户离开过该字段（touched）才报，
 * 这样刚打开的空表单不会满屏红字。
 */
export function fieldProblems(
  draft: UpstreamDraft,
  mode: DraftMode,
  touched: ReadonlySet<DraftField>,
): Partial<Record<DraftField, FieldProblem>> {
  const result: Partial<Record<DraftField, FieldProblem>> = {};
  if (mode === "create" && draft.name !== "") {
    const problem = upstreamNameProblem(draft.name);
    if (problem === "format") result.name = "name";
    else if (problem === "reserved") result.name = "nameReserved";
  }
  if (draft.displayName.trim() === "" && touched.has("displayName")) result.displayName = "displayName";
  if (!normalizeUpstreamBaseUrl(draft.baseUrl).ok && (draft.baseUrl.trim() !== "" || touched.has("baseUrl"))) {
    result.baseUrl = "baseUrl";
  }
  if (apiKeyDraftInvalid(draft)) result.apiKey = "apiKey";
  return result;
}

/**
 * 服务端返回的 `aliases.<下标>.alias` 路径 → 草稿里对应的行下标。
 * 请求体丢弃了空白行，所以服务端下标要折算回草稿；对不上返回 null
 */
export function aliasConflictRow(draft: UpstreamDraft, path: string | undefined): number | null {
  const match = /^aliases\.(\d+)\.alias$/.exec(path ?? "");
  if (match === null) return null;
  const rows = draft.aliases.map((row, index) => ({ row, index })).filter(({ row }) => !aliasRowBlank(row));
  return rows[Number(match[1])]?.index ?? null;
}

/** 请求体里的一条别名；目标留空时不带 upstreamModel */
export interface AliasBody {
  alias: string;
  upstreamModel?: string;
}

/** 有内容的别名行 → 请求体（trim；空目标不带 upstreamModel） */
function aliasBodies(draft: UpstreamDraft): AliasBody[] {
  return draft.aliases
    .filter((row) => !aliasRowBlank(row))
    .map((row) => {
      const target = row.upstreamModel.trim();
      return target === "" ? { alias: row.alias.trim() } : { alias: row.alias.trim(), upstreamModel: target };
    });
}

export function buildCreateBody(draft: UpstreamDraft): Record<string, string | AliasBody[]> {
  const body: Record<string, string | AliasBody[]> = {
    name: draft.name,
    displayName: draft.displayName.trim(),
    baseUrl: draft.baseUrl.trim(),
  };
  if (draft.apiKey.trim() !== "") body.apiKey = draft.apiKey.trim();
  if (draft.upstreamModel.trim() !== "") body.upstreamModel = draft.upstreamModel.trim();
  if (draft.note.trim() !== "") body.note = draft.note.trim();
  const aliases = aliasBodies(draft);
  if (aliases.length > 0) body.aliases = aliases;
  return body;
}

/** 编辑保存 = 别名整表替换，所以总是带 aliases（清空就是空数组） */
export function buildUpdateBody(draft: UpstreamDraft): Record<string, string | null | AliasBody[]> {
  const body: Record<string, string | null | AliasBody[]> = {
    displayName: draft.displayName.trim(),
    baseUrl: draft.baseUrl.trim(),
    upstreamModel: draft.upstreamModel.trim() === "" ? null : draft.upstreamModel.trim(),
    note: draft.note.trim() === "" ? null : draft.note.trim(),
    aliases: aliasBodies(draft),
  };
  if (draft.clearApiKey) body.apiKey = "";
  else if (draft.apiKey.trim() !== "") body.apiKey = draft.apiKey.trim();
  return body;
}

/** POST /api/v1/upstreams/test 的请求体（保存前验证） */
export function buildTestBody(draft: UpstreamDraft, mode: DraftMode): Record<string, string | null> {
  const baseUrl = draft.baseUrl.trim();
  if (draft.apiKey.trim() !== "") return { baseUrl, apiKey: draft.apiKey.trim() };
  if (mode === "edit" && !draft.clearApiKey) return { baseUrl, name: draft.name };
  return { baseUrl, apiKey: null };
}
