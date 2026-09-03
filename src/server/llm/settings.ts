import type Database from "better-sqlite3";

import { parseExtraBody } from "@/lib/llm-extra-body";

/**
 * LLM 解析引擎的配置读写（批 3）
 *
 * 外部凭据照 `hf/settings.ts` 的 `effectiveToken` 同构：**env 优先且只读，db 次之**。
 * 不新开凭据表——`settings` 表已经在存 `outbound_proxy`（同样含凭据），
 * `hf_token` 那张独立表是 M2 的历史形态，不作为新增时的样板。
 *
 * `engine` 只存 db：它是用户的一次选择，不是部署参数，没有 env 覆盖的必要。
 * 默认 `none`——装了面板不等于同意往外发请求。
 */

export type LlmEngine = "none" | "local" | "external";

const KEY = {
  engine: "llm_engine",
  baseUrl: "llm_base_url",
  apiKey: "llm_api_key",
  model: "llm_model",
  extraBody: "llm_extra_body",
} as const;

const ENV = {
  baseUrl: "PANEL_LLM_BASE_URL",
  apiKey: "PANEL_LLM_API_KEY",
  model: "PANEL_LLM_MODEL",
  extraBody: "PANEL_LLM_EXTRA_BODY",
} as const;

export type FieldSource = "env" | "db" | null;

export interface LlmSettingsSnapshot {
  engine: LlmEngine;
  baseUrl: string | null;
  baseUrlSource: FieldSource;
  keySet: boolean;
  /**
   * 明文后 4 位，未设置为 null。**任何情况下都不回明文**
   * 明文短于 8 位时同样为 null：`slice(-4)` 在这种长度下取到的就是整条明文，
   * 尾 4 位的用途是"让用户认出这是哪把钥匙"——短到认不出的东西，回它只剩泄漏、没有收益
   */
  keyTail: string | null;
  keySource: FieldSource;
  model: string | null;
  modelSource: FieldSource;
  extraBody: string | null;
  extraBodySource: FieldSource;
  /** 外部三项是否配齐 */
  externalReady: boolean;
  /** 没配齐时缺哪些——UI 要逐项点名，只说"配置不完整"用户还得自己找 */
  missing: ("baseUrl" | "apiKey" | "model")[];
}

function readDb(db: Database.Database, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  const value = row?.value.trim();
  return value === undefined || value === "" ? undefined : value;
}

function effective(
  db: Database.Database,
  envKey: string,
  dbKey: string,
): { value: string | undefined; source: FieldSource } {
  const fromEnv = process.env[envKey]?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return { value: fromEnv, source: "env" };
  const fromDb = readDb(db, dbKey);
  return fromDb === undefined ? { value: undefined, source: null } : { value: fromDb, source: "db" };
}

export function getLlmSettings(db: Database.Database): LlmSettingsSnapshot {
  const baseUrl = effective(db, ENV.baseUrl, KEY.baseUrl);
  const apiKey = effective(db, ENV.apiKey, KEY.apiKey);
  const model = effective(db, ENV.model, KEY.model);
  const extraBody = effective(db, ENV.extraBody, KEY.extraBody);

  const missing: ("baseUrl" | "apiKey" | "model")[] = [];
  if (baseUrl.value === undefined) missing.push("baseUrl");
  if (apiKey.value === undefined) missing.push("apiKey");
  if (model.value === undefined) missing.push("model");

  const rawEngine = readDb(db, KEY.engine);
  const engine: LlmEngine =
    rawEngine === "local" || rawEngine === "external" ? rawEngine : "none";

  return {
    engine,
    baseUrl: baseUrl.value ?? null,
    baseUrlSource: baseUrl.source,
    keySet: apiKey.value !== undefined,
    keyTail:
      apiKey.value === undefined || apiKey.value.length < 8 ? null : apiKey.value.slice(-4),
    keySource: apiKey.source,
    model: model.value ?? null,
    modelSource: model.source,
    extraBody: extraBody.value ?? null,
    extraBodySource: extraBody.source,
    externalReady: missing.length === 0,
    missing,
  };
}

export interface LlmConfig {
  engine: LlmEngine;
  baseUrl: string | null;
  /** 明文。只在服务端发请求时使用，绝不进任何响应体 */
  apiKey: string | null;
  model: string | null;
  extraBody: Record<string, unknown> | null;
}

/** 服务端发请求用的生效配置（含明文 key）。这是唯一能拿到明文的入口 */
export function resolveLlmConfig(db: Database.Database): LlmConfig {
  const snapshot = getLlmSettings(db);
  const apiKey = effective(db, ENV.apiKey, KEY.apiKey).value ?? null;
  return {
    engine: snapshot.engine,
    // 末尾斜杠归一化：下游一律 `${baseUrl}/chat/completions`，留着斜杠会拼出 //
    baseUrl: snapshot.baseUrl === null ? null : snapshot.baseUrl.replace(/\/+$/, ""),
    apiKey,
    model: snapshot.model,
    extraBody: parseExtraBody(snapshot.extraBody),
  };
}

export interface LlmSettingsPatch {
  engine?: LlmEngine;
  /**
   * null = 清除 db 里那份（env 若有仍然生效——那是部署方的决定，面板改不动）。
   * 空串 / 纯空白串与 null 同义，同样触发清除：UI 侧"清空输入框后保存"传的是 ""
   * 而不是 null，若不归一化就会在 db 里存一个空字符串——`effective()` 虽然会把它
   * 当"未设置"处理（`readDb` 对空串也返回 undefined），但这行空值本身不该留在表里。
   */
  baseUrl?: string | null;
  apiKey?: string | null;
  model?: string | null;
  extraBody?: string | null;
}

export function saveLlmSettings(db: Database.Database, patch: LlmSettingsPatch): void {
  const write = (key: string, value: string | null | undefined): void => {
    if (value === undefined) return;
    // null 与空串/纯空白串同义，都是"清除"——见 LlmSettingsPatch 顶部注释
    if (value === null || value.trim() === "") {
      db.prepare("DELETE FROM settings WHERE key = ?").run(key);
      return;
    }
    db.prepare(
      "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, value.trim());
  };

  write(KEY.engine, patch.engine);
  write(KEY.baseUrl, patch.baseUrl);
  write(KEY.apiKey, patch.apiKey);
  write(KEY.model, patch.model);
  write(KEY.extraBody, patch.extraBody);
}
