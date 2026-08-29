import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { buildProxyRequest, llamaUpstreamBase, sanitizeUpstreamResponse } from "@/server/llamaProxy";
import { getSharedDockerAdapter } from "@/server/locators";
import { getRunningContainerInfo } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Playground 反代（M3 Task 6，设计 §10）：`/api/v1/proxy/llama/*` →
 * `http://127.0.0.1:<运行容器 host_port>/<path>?<query>` 全方法透传。
 *
 * SSH 隧道场景只暴露面板一个端口，`/completion`、`/v1/chat/completions` 等
 * 推理 API 都可经此入口——同源请求自动带 session cookie，requireAuth 天然
 * 可用（API token Bearer 也放行，curl 测试友好）。
 *
 * **Chat 页的 iframe 不走这里**（M5 改直连）：llama.cpp 自带 web UI 的 bundle
 * 内含根绝对路径（/v1/models、/props、/tools），经本前缀必然 404。理由与直连
 * 的信任边界见 app/(panel)/chat/page.tsx 头注释。
 *
 * 流式：请求体 req.body 直传 fetch（duplex "half"）、响应体 upstream.body
 * 直传 Response，SSE / chat 流式逐块到达（组装与 header 清洗的可测部分收敛
 * 在 server/llamaProxy.ts 纯函数，此处只做鉴权 / 运行状态 / 错误映射薄壳）。
 *
 * 错误形态（Content-Type 均 json）：
 * - 未运行 → 503 `{error:"没有运行中的模型", hint:"/models"}`
 * - 运行中但 host_port 未知（模型行已删）→ 503 同上（message 不同）
 * - 上游连接失败（容器端口未就绪 / 拒绝，启动窗口期常见）→ 502 `{error:"容器端口未就绪"}`
 * - OPTIONS 在 503/502 时回 204 + Allow（浏览器预检不因服务未起而炸）
 *
 * 路由用可选 catch-all `[[...path]]` 而非 `[...path]`：根入口
 * `/api/v1/proxy/llama`（无后续段）必须命中本路由（必选 catch-all 不匹配空段）。
 */

/** OPTIONS 预检兜底响应的 Allow 头 */
const ALLOW_METHODS = "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS";

/** 错误响应；OPTIONS 特判回 204（预检不炸），其余按状态码出 JSON */
function fail(req: Request, status: 502 | 503, payload: Record<string, string>): Response {
  if (req.method.toUpperCase() === "OPTIONS") {
    return new Response(null, { status: 204, headers: { Allow: ALLOW_METHODS } });
  }
  return NextResponse.json(payload, { status });
}

/** 全方法统一的转发 handler（下方按 HTTP 动词导出） */
async function proxy(req: Request, ctx: { params: Promise<{ path?: string[] }> }): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const info = await getRunningContainerInfo(getDb(), getSharedDockerAdapter());
  if (info === null) {
    return fail(req, 503, { error: "没有运行中的模型", hint: "/models" });
  }
  if (info.hostPort === null) {
    // 容器在跑但模型行已删（getRunningContainerInfo 的降级形态）：端口无从得知
    return fail(req, 503, { error: "运行中模型的端口未知（模型配置缺失）", hint: "/models" });
  }

  const { path } = await ctx.params;
  const { url, init } = buildProxyRequest(req, llamaUpstreamBase(info.hostPort), path);

  let upstream: Response;
  try {
    upstream = await fetch(url, init);
  } catch {
    // 连接拒绝 / 端口未就绪（容器刚起 llama-server 未监听）等网络层失败
    return fail(req, 502, { error: "容器端口未就绪" });
  }
  return sanitizeUpstreamResponse(upstream);
}

// Next 按导出名分发 HTTP 方法；七个动词共用同一 handler
export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
export const PUT = proxy;
export const DELETE = proxy;
export const PATCH = proxy;
export const OPTIONS = proxy;
