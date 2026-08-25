/**
 * Playground 反代纯函数（M3 Task 6，设计 §10）
 *
 * 把 `/api/v1/proxy/llama/*` 的请求转发到当前运行容器的
 * `http://127.0.0.1:<host_port>/<path>?<query>`（host_port 来自
 * runtime.getRunningContainerInfo），请求体与响应体都以流透传
 * （req.body 直传 fetch + upstream.body 直传 Response，duplex "half"），
 * llama.cpp 的 SSE / chat 流式逐块到达，不在面板进程缓冲。
 *
 * 本文件只做无副作用的组装与 header 清洗（可单测）；运行状态查询、
 * 鉴权、错误映射在 route 薄壳里（见 app/api/v1/proxy/llama/[[...path]]/route.ts）。
 */

/** 请求侧剔除的头（小写比较）：
 *  - hop-by-hop（connection / keep-alive / upgrade / te / trailer / proxy-*）
 *  - 由 fetch 按新目标重算的 host / content-length / transfer-encoding
 *  - 面板凭证与自身头：cookie（session）与 authorization（lp_ API token）
 *    不应泄漏给模型容器，authorization 还会与 llama-server 自身的
 *    --api-key Bearer 校验冲突；x-llamapad-* 是面板内部头。
 *  多值头不特殊处理（上述头均不合法多值，遍历取末值等价于删除）。 */
const REQUEST_STRIP_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "proxy-connection",
  "te",
  "trailer",
  "cookie",
  "authorization",
]);

/** 响应侧剔除的头（小写比较）：hop-by-hop 一族。
 *  content-type / content-encoding / content-length 原样保留——
 *  请求侧已强制 accept-encoding: identity，上游不会压缩，undici 不会解压，
 *  content-length 因此与透传体始终一致（宁可少删不坏）。 */
const RESPONSE_STRIP_HEADERS = new Set([
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "proxy-connection",
  "te",
  "trailer",
]);

/** Response 构造器禁止带体的状态码（上游这些状态本就无体，显式置 null 防御） */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * 上游路径拼接（纯函数）：
 * 段列表（Next catch-all params，已解码）为空 / 空数组 / [""] 时打到上游根 `/`，
 * 否则逐段 encodeURIComponent 后以 `/` 连接（防已解码段里的特殊字符裸拼进 URL）；
 * query 原样保留（search 含前导 "?"，无 query 为空串）。
 */
export function buildUpstreamPath(pathSegments: string[] | undefined, search: string): string {
  const segments = (pathSegments ?? []).filter((segment) => segment !== "");
  const path = segments.length > 0 ? `/${segments.map(encodeURIComponent).join("/")}` : "/";
  return search ? `${path}${search}` : path;
}

/**
 * 组装发给上游的 fetch 目标与 init（纯函数，不发请求）。
 *
 * - targetBase：`http://127.0.0.1:<host_port>`（不带尾斜杠），由 route 传入
 * - header 清洗见 REQUEST_STRIP_HEADERS；accept-encoding 强制 identity
 *   （上游不压缩 → undici 不解压 → content-length 不失配，选 identity 最稳）
 * - 补转发三件套：x-forwarded-for（既有值追加 127.0.0.1——SSH 隧道场景
 *   客户端确经回环接入，且 route handler 无公开 API 拿真实远端地址）、
 *   x-forwarded-host（客户端访问面板的原始 host）、x-forwarded-proto
 *   （缺省 http，面板自身不终止 TLS，链上已有值则保留）
 * - GET / HEAD 无请求体；其余方法把 req.body 流原样交给 fetch（duplex "half"，
 *   TS lib.dom 的 RequestInit 无 duplex 字段，与 hf/client.ts 的 dispatcher
 *   同款 as 断言）；redirect "manual" 不在上游侧跟随，3xx 原样透传给浏览器
 * - signal 挂客户端连接：浏览器取消（iframe 跳走 / curl 中断）时连带取消上游
 */
export function buildProxyRequest(
  req: Request,
  targetBase: string,
  pathSegments: string[] | undefined,
): { url: string; init: RequestInit } {
  const url = `${targetBase}${buildUpstreamPath(pathSegments, new URL(req.url).search)}`;

  const headers = new Headers();
  for (const [key, value] of req.headers) {
    const lower = key.toLowerCase();
    if (REQUEST_STRIP_HEADERS.has(lower)) continue;
    if (lower.startsWith("x-llamapad-")) continue;
    headers.set(key, value);
  }
  headers.set("accept-encoding", "identity");

  const originalHost = req.headers.get("host");
  if (originalHost !== null) headers.set("x-forwarded-host", originalHost);
  const priorFor = req.headers.get("x-forwarded-for");
  headers.set("x-forwarded-for", priorFor ? `${priorFor}, 127.0.0.1` : "127.0.0.1");
  if (req.headers.get("x-forwarded-proto") === null) headers.set("x-forwarded-proto", "http");

  const method = req.method.toUpperCase();
  const init: RequestInit = {
    method,
    headers,
    redirect: "manual",
    signal: req.signal,
  };
  if (method !== "GET" && method !== "HEAD" && req.body !== null) {
    init.body = req.body;
    (init as RequestInit & { duplex?: "half" }).duplex = "half";
  }
  return { url, init };
}

/**
 * 上游响应 → 面板响应（纯函数，不复制体）：
 * 剔除 RESPONSE_STRIP_HEADERS 中的 hop-by-hop 头，其余（含
 * content-type / content-encoding / content-length）原样保留；
 * upstream.body 流直传给新 Response（SSE / chunked 逐块透传）；
 * 无体状态码（204/205/304）显式置 null（Response 构造器对"无体状态 + 体"抛错）。
 *
 * 注：fetch 永不返回 101 等协议升级响应（undici 直接抛错，route 侧落 502 分支），
 * 故无需为 <200 状态设防。
 */
export function sanitizeUpstreamResponse(upstream: Response): Response {
  const headers = new Headers();
  for (const [key, value] of upstream.headers) {
    if (!RESPONSE_STRIP_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  }
  const body = NULL_BODY_STATUSES.has(upstream.status) ? null : upstream.body;
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}
