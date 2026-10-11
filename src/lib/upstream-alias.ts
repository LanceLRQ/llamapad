/**
 * 外部上游别名的规范化与校验（纯函数，client / server 共用，不依赖 Node 内置模块）。
 *
 * 别名是中转请求里 model 的另一种写法，与托管模型名、上游名称共用一个命名空间；
 * 跨表的唯一性由仓储检查（server/repo/upstreams.ts），这里只管单次提交内部的问题。
 * 别名不做 trim：首尾空白直接判为格式错误，免得悄悄改写用户写下的名字。
 */

/** 比上游名宽：允许大写与 . _ : /，以便照搬 OpenAI / HF 风格的模型名 */
export const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
export const ALIAS_MAX_LENGTH = 128;
export const ALIAS_TARGET_MAX_LENGTH = 256;
export const MAX_ALIASES_PER_UPSTREAM = 50;

export interface UpstreamAliasInput {
  alias: string;
  upstreamModel?: string | null;
}

export interface UpstreamAlias {
  alias: string;
  upstreamModel: string | null;
}

export function aliasProblem(alias: string): "format" | "length" | null {
  if (!ALIAS_PATTERN.test(alias)) return "format";
  if (alias.length > ALIAS_MAX_LENGTH) return "length";
  return null;
}

export type AliasProblemReason = "format" | "length" | "targetLength" | "duplicate" | "ownerName" | "tooMany";

export type NormalizeAliasesResult =
  | { ok: true; aliases: UpstreamAlias[] }
  | {
      ok: false;
      /** 出问题的行下标；整组问题（tooMany）为 null */
      index: number | null;
      field: "alias" | "upstreamModel" | "group";
      reason: AliasProblemReason;
    };

/** 规范化并校验一组别名输入，返回第一个问题。upstreamName 用于排除「别名等于所属上游名称」 */
export function normalizeAliases(inputs: readonly UpstreamAliasInput[], upstreamName: string): NormalizeAliasesResult {
  if (inputs.length > MAX_ALIASES_PER_UPSTREAM) {
    return { ok: false, index: null, field: "group", reason: "tooMany" };
  }
  const seen = new Set<string>();
  const aliases: UpstreamAlias[] = [];
  for (let index = 0; index < inputs.length; index++) {
    const input = inputs[index];
    const problem = aliasProblem(input.alias);
    if (problem !== null) return { ok: false, index, field: "alias", reason: problem };
    if (input.alias === upstreamName) return { ok: false, index, field: "alias", reason: "ownerName" };
    if (seen.has(input.alias)) return { ok: false, index, field: "alias", reason: "duplicate" };
    seen.add(input.alias);
    const trimmed = input.upstreamModel?.trim() ?? "";
    if (trimmed.length > ALIAS_TARGET_MAX_LENGTH) {
      return { ok: false, index, field: "upstreamModel", reason: "targetLength" };
    }
    aliases.push({ alias: input.alias, upstreamModel: trimmed === "" ? null : trimmed });
  }
  return { ok: true, aliases };
}
