import { LLAMA_PROXY_ALIAS, LLAMA_PROXY_ROUTE } from "./proxy-alias";

/**
 * API 中转页「接入信息」的纯逻辑：对外地址怎么拼、示例怎么写。
 *
 * origin 由服务端从请求头推导而不是在客户端读 window.location：页面是服务端渲染的，
 * 客户端再读一次会让首帧与水合后的地址不一致。经反代访问时 x-forwarded-* 给出的
 * 就是浏览器地址栏里的那个。
 */

/** 逗号分隔的多值头取第一个（多级反代会追加） */
function first(value: string | null): string | null {
  const head = value?.split(",")[0]?.trim() ?? "";
  return head === "" ? null : head;
}

export function originFromHeaders(get: (name: string) => string | null): string {
  const host = first(get("x-forwarded-host")) ?? first(get("host"));
  if (host === null) return "";
  const proto = first(get("x-forwarded-proto")) ?? "http";
  return `${proto}://${host}`;
}

export interface RelayBaseUrls {
  /** 短地址（/llama-proxy 别名） */
  short: string;
  /** 长地址（真实路由） */
  long: string;
}

/** OpenAI 兼容客户端要填的 base URL：到 /v1 为止 */
export function relayBaseUrls(origin: string): RelayBaseUrls {
  const base = origin.replace(/\/+$/, "");
  return { short: `${base}${LLAMA_PROXY_ALIAS}/v1`, long: `${base}${LLAMA_PROXY_ROUTE}/v1` };
}

/** 没有默认模型时示例里用的占位名 */
export const SNIPPET_PLACEHOLDER_MODEL = "your-model";

export function buildCurlSnippet(baseUrl: string, model: string | null): string {
  const body = JSON.stringify({
    model: model ?? SNIPPET_PLACEHOLDER_MODEL,
    messages: [{ role: "user", content: "Hello" }],
  });
  return [
    `curl ${baseUrl}/chat/completions \\`,
    `  -H "Authorization: Bearer lp_xxxxxxxx" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${body}'`,
  ].join("\n");
}

/** 启动时间的展示文本。固定用 UTC：服务端与浏览器时区不同，本地化会造成水合不一致 */
export function formatStartedAt(iso: string | null): string | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}
