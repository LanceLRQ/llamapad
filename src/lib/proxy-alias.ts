/**
 * 推理中转接口的短地址别名：`/llama-proxy/*` → `/api/v1/proxy/llama/*`。
 *
 * ⚠️ 与同目录的 `proxy-rewrite.ts` 是两回事，只是名字相近：那边改的是**请求体**
 * （reasoning_effort 映射），这边改的是 **URL 前缀**，互不相干。
 *
 * 为什么改前缀是安全的：中转 handler 拼上游地址时只用 catch-all 的 `params.path`
 * 与 query（见 server/llamaProxy.ts 的 buildUpstreamPath），**请求前缀一个字符都
 * 不参与**。Next 的 rewrite 是内部重写，路由匹配按 destination 的形状做，因此
 * `params` 与 `search` 与走长地址时完全一致，转发出去的上游 URL 一字不差。
 *
 * 两条规则缺一不可：`:path*` 匹配不到零段，少了第二条 `/llama-proxy` 本身会 404
 * ——而真实路由特意用可选 catch-all `[[...path]]` 而非 `[...path]`，为的就是让
 * 这个根入口可用（见该 route.ts 头注释）。
 *
 * 这是**新增别名，不是搬家**：长地址继续有效，前端既有调用点（chat/playground.tsx、
 * chat/param-bar.tsx）无需改动。短地址也不降低鉴权要求——requireAuth 在 handler
 * 内部，两个入口都要 session cookie 或 Bearer token。
 *
 * 以数组形式交给 next.config.ts，即 Next 的 afterFiles 时机：文件系统路由先匹配，
 * 别名不会遮蔽任何真实路由。
 */

/** 真实路由前缀（app 目录下 `api/v1/proxy/llama/[[...path]]`） */
export const LLAMA_PROXY_ROUTE = "/api/v1/proxy/llama";

/** 对外的短地址前缀。`/llama-proxy/v1/models` 比长地址少一个 `v1`——
 *  长地址里那两个 `v1` 语义不同（前者面板 API 版本、后者 llama-server 的），
 *  并排出现相当容易看花 */
export const LLAMA_PROXY_ALIAS = "/llama-proxy";

export function llamaProxyRewrites(): ReadonlyArray<{ source: string; destination: string }> {
  return [
    { source: `${LLAMA_PROXY_ALIAS}/:path*`, destination: `${LLAMA_PROXY_ROUTE}/:path*` },
    { source: LLAMA_PROXY_ALIAS, destination: LLAMA_PROXY_ROUTE },
  ];
}
