/**
 * `PANEL_LLM_EXTRA_BODY`：透传给 provider 的额外请求体字段（批 3）
 *
 * **存在的理由是实测数据**：同一个抽取请求，推理模型开思考 1034 tokens、
 * 关思考 12 tokens，差 86 倍。但关思考的字段（智谱是 `thinking`）不是 OpenAI
 * 标准，把它硬编码进代码就等于把面板绑死在一个厂商上。
 *
 * 于是给用户一个通用口子，自己按 provider 文档填。代价是这段 JSON 不可校验语义——
 * 所以**非法内容一律降级为"没配"而不是报错**：填错一个字符不该让整个功能不可用。
 */

export function parseExtraBody(raw: string | null | undefined): Record<string, unknown> | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 设置页失焦校验用（批 3 任务 17 复核发现②）：口径必须与 `parseExtraBody`
 * 完全同构，否则前端「看起来合法」的输入到了服务端（PUT /api/v1/settings/llm
 * 的校验分支同样是"合法 JSON 且顶层非数组对象"）却被拒绝，早期反馈就失效了。
 *
 * 空/纯空白视为有效——空就是"没配"，不是"配错了"，不该红框。非空则复用
 * `parseExtraBody` 的判定（同一次 JSON.parse + 同一条对象/数组检查），不重写
 * 一遍规则以免两处口径将来悄悄跑偏。
 */
export function isValidExtraBody(raw: string): boolean {
  if (raw.trim() === "") return true;
  return parseExtraBody(raw) !== null;
}

/**
 * 合并顺序：额外字段在前、面板字段在后覆盖。
 * `model` / `messages` / `stream` / `response_format` 是面板的核心请求语义，
 * 用户从这个口子改掉它们只会让功能以难以诊断的方式失效。
 */
export function mergeRequestBody(
  extra: Record<string, unknown> | null,
  core: Record<string, unknown>,
): Record<string, unknown> {
  return extra === null ? core : { ...extra, ...core };
}
