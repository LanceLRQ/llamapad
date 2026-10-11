/**
 * 从中转请求里取出客户端指定的模型名。发往谁的判定在 lib/relay-route.ts。
 */

/** 从 JSON 请求体取 model 字段；取不到（非 JSON、非对象、字段缺失/空白/非字符串）返回 null */
export function extractRequestedModel(rawBody: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const value = (parsed as Record<string, unknown>).model;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** GET / HEAD 等无请求体的调用从查询串 ?model= 取（llama-server 的 router 模式也用这个参数名） */
export function requestedModelFromQuery(params: URLSearchParams): string | null {
  const trimmed = params.get("model")?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}
