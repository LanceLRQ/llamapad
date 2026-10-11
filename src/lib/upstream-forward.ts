/**
 * 转发到外部上游前的请求体改写（纯函数）。
 *
 * 面板对外的模型名是上游的登记名（如 strata），上游自己认的模型名往往是另一个
 * （如 Qwen3.8-Flash-…）。登记时填了 upstream_model，就在这里把请求体的 model 换成它；
 * 没填则原样透传，适用于上游不校验 model 字段的情况。
 */
export function applyUpstreamModel(rawBody: string, upstreamModel: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return rawBody;
  return JSON.stringify({ ...(parsed as Record<string, unknown>), model: upstreamModel });
}
