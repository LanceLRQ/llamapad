import { NextResponse } from "next/server";
import {
  effortHeaderValue,
  enhanceModelsResponse,
  isModelsListPath,
  isRewriteTarget,
  rewriteRequestBody,
} from "@/lib/proxy-rewrite";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getEffortMappingContext } from "@/server/effortContext";
import { buildProxyRequest, llamaUpstreamBase, sanitizeUpstreamResponse } from "@/server/llamaProxy";
import { getPanelModelsRoot, getSharedDockerAdapter } from "@/server/locators";
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
 * **Chat 页的自建 Playground 现在正是这里的主要消费者**：对话请求、参数栏取
 * /props、「查看请求体」全部经本前缀同源转发（M5 曾让 iframe 直连 llama-server
 * 绕开这里，那条路径已随 iframe 一起废弃，见 app/(panel)/chat/page.tsx 头注释）。
 *
 * 流式：请求体 req.body 直传 fetch（duplex "half"）、响应体 upstream.body
 * 直传 Response，SSE / chat 流式逐块到达（组装与 header 清洗的可测部分收敛
 * 在 server/llamaProxy.ts 纯函数，此处只做鉴权 / 运行状态 / 错误映射薄壳）。
 *
 * 「思考强度中转映射」接线（最后一批）：
 * - POST 且命中 lib/proxy-rewrite.ts 白名单（/v1/chat/completions、/chat/completions、
 *   /apply-template）时，先缓冲请求体改写 reasoning_effort，再整体作为
 *   overrideBody 交给 buildProxyRequest；发生改写时在响应上补
 *   x-llamapad-reasoning-effort 诊断头。请求体超过 4MB（或 content-length 缺失，
 *   无法安全判断）一律跳过改写、按原有零拷贝流式透传处理——长对话不能因为
 *   面板自己的中转逻辑而失败，同样在响应头标注"跳过改写"而非静默不作声
 * - GET /v1/models（含别名 /models）额外缓冲一次上游响应（很小），注入
 *   supported_parameters / x_llamapad 后返回，供 Cherry Studio 一类客户端
 *   自行判断该发什么值
 * - 其余所有路径 / 方法维持原有零拷贝流式透传，一个字节都不变
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

/** 改写候选请求体大小上限（字节）：超限一律不改写，保持零拷贝流式透传。
 *  只看 content-length 头，不为了判大小就把整个 body 读进内存——这正是要避免的事；
 *  头缺失（罕见，标准 JSON POST 客户端都会带上）时同样保守按"超限"处理，
 *  不做二次探测式读取（那同样是在为了判大小而读 body，只是换了个由头）。 */
const MAX_REWRITE_BODY_BYTES = 4 * 1024 * 1024;

/** 命中白名单但因体积原因跳过改写时的诊断头文案：不走 effortHeaderValue——
 *  那个格式要求已知 requested 值，而这里为了不读大体压根没解析请求体 */
const REWRITE_SKIPPED_TOO_LARGE = "skipped (body too large)";

function withinRewriteLimit(req: Request): boolean {
  const raw = req.headers.get("content-length");
  if (raw === null) return false;
  const length = Number(raw);
  return Number.isFinite(length) && length <= MAX_REWRITE_BODY_BYTES;
}

/** GET /v1/models（及别名 /models）：缓冲上游响应并注入思考强度能力声明 */
async function proxyModelsList(
  req: Request,
  url: string,
  init: RequestInit,
  db: ReturnType<typeof getDb>,
  model: string,
): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(url, init);
  } catch {
    return fail(req, 502, { error: "容器端口未就绪" });
  }
  const sanitized = sanitizeUpstreamResponse(upstream);
  if (sanitized.body === null) return sanitized; // 无体状态码（204/304 等），没有可增强的内容

  const upstreamText = await sanitized.text();
  const { support, config } = await getEffortMappingContext(db, getPanelModelsRoot(), model);
  const enhanced = enhanceModelsResponse(upstreamText, support, config);

  // body 大小已变化，原 content-length 头会失配，交给运行时按新体重算
  const headers = new Headers(sanitized.headers);
  headers.delete("content-length");
  return new Response(enhanced, { status: sanitized.status, statusText: sanitized.statusText, headers });
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
  const method = req.method.toUpperCase();
  const db = getDb();
  const targetBase = llamaUpstreamBase(info.hostPort);

  if (method === "GET" && isModelsListPath(path)) {
    const { url, init } = buildProxyRequest(req, targetBase, path);
    return proxyModelsList(req, url, init, db, info.model);
  }

  let overrideBody: string | undefined;
  let headerValue: string | null = null;
  if (isRewriteTarget(method, req.headers.get("content-type"), path)) {
    if (withinRewriteLimit(req)) {
      const rawBody = await req.text();
      const { support, config } = await getEffortMappingContext(db, getPanelModelsRoot(), info.model);
      const result = rewriteRequestBody(rawBody, support, config);
      overrideBody = result.body;
      if (result.resolution !== null && result.requested !== undefined) {
        headerValue = effortHeaderValue(result.requested, result.resolution);
      }
    } else {
      // 体积超限（或 content-length 缺失无法安全判断）：不读 body，原样走下面的流式透传，
      // 只在响应头留痕，避免客户端误以为"没有 reasoning_effort 字段"
      headerValue = REWRITE_SKIPPED_TOO_LARGE;
    }
  }

  const { url, init } = buildProxyRequest(req, targetBase, path, overrideBody);

  let upstream: Response;
  try {
    upstream = await fetch(url, init);
  } catch {
    // 连接拒绝 / 端口未就绪（容器刚起 llama-server 未监听）等网络层失败
    return fail(req, 502, { error: "容器端口未就绪" });
  }
  const sanitized = sanitizeUpstreamResponse(upstream);
  if (headerValue !== null) sanitized.headers.set("x-llamapad-reasoning-effort", headerValue);
  return sanitized;
}

// Next 按导出名分发 HTTP 方法；七个动词共用同一 handler
export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
export const PUT = proxy;
export const DELETE = proxy;
export const PATCH = proxy;
export const OPTIONS = proxy;
