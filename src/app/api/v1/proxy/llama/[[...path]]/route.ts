import { NextResponse } from "next/server";
import { decideModelRoute, extractRequestedModel, requestedModelFromQuery } from "@/lib/model-route";
import {
  effortHeaderValue,
  isJsonContentType,
  isModelsListPath,
  isRewriteTarget,
  rewriteRequestBody,
} from "@/lib/proxy-rewrite";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getEffortMappingContext } from "@/server/effortContext";
import { buildProxyRequest, llamaUpstreamBase, sanitizeUpstreamResponse } from "@/server/llamaProxy";
import { getPanelModelsRoot, getRuntimeService } from "@/server/locators";
import { buildAggregatedModelsList } from "@/server/modelsListProxy";
import { createModelRepo } from "@/server/repo/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Playground 与 API 中转（M3 Task 6，设计 §10；多模型并行改造 2026-09-16）：
 * `/api/v1/proxy/llama/*` → `http://<PANEL_LLAMA_HOST>:<目标模型的实际端口>/<path>?<query>` 全方法透传。
 *
 * SSH 隧道场景只暴露面板一个端口，`/completion`、`/v1/chat/completions` 等推理 API
 * 都可经此入口——同源请求自动带 session cookie，requireAuth 天然可用（API token
 * Bearer 也放行，curl 测试友好）。Chat 页的自建 Playground 是主要消费者之一。
 *
 * 发往哪个模型（决策 D6，判定在 lib/model-route.ts）：
 * - JSON POST 读请求体的 model 字段；GET 等无体请求读查询串 `?model=`
 * - 请求的模型在跑 → 发往它；面板里配置过但没在跑 → 404（OpenAI 错误格式，
 *   code: model_not_running）；面板不认识的名字或没带 → 默认模型
 * - 响应头 x-llamapad-model 标注实际目标，x-llamapad-model-route 标注原因
 *   （requested / default / fallback-default）
 *
 * 请求体缓冲：JSON POST 且 content-length ≤ 4MB 时读一次，既用来取 model，也给
 * 「思考强度中转映射」改写（白名单路径 /v1/chat/completions、/chat/completions、
 * /apply-template）；超限或 content-length 缺失时不读，按不带 model 处理、零拷贝
 * 流式透传，命中白名单时在 x-llamapad-reasoning-effort 头标注「跳过改写」。
 * 响应体始终流式透传，SSE 逐块到达。
 *
 * GET /v1/models（及别名 /models）：面板自己聚合全部运行中且已响应的模型（决策 D7，
 * 见 server/modelsListProxy.ts），默认模型排第一；没有模型在跑时返回空列表。
 *
 * 错误形态（Content-Type 均 json）：
 * - 没有模型在跑 → 503 `{error:"没有运行中的模型", hint:"/models/profiles"}`
 * - 目标模型端口未知（旧版面板起的无标签容器，模型行也已删）→ 503 同上（message 不同）
 * - 请求的模型没在跑 → 404 `{error:{message, type:"invalid_request_error", code:"model_not_running"}}`
 * - 上游连接失败（容器端口未就绪，启动窗口期常见）→ 502 `{error:"容器端口未就绪"}`
 * - OPTIONS 在上述错误时一律回 204 + Allow（浏览器预检不因服务未起而炸）
 *
 * 路由用可选 catch-all `[[...path]]` 而非 `[...path]`：根入口
 * `/api/v1/proxy/llama`（无后续段）必须命中本路由（必选 catch-all 不匹配空段）。
 */

/** OPTIONS 预检兜底响应的 Allow 头 */
const ALLOW_METHODS = "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS";

function preflightFallback(req: Request): Response | null {
  return req.method.toUpperCase() === "OPTIONS"
    ? new Response(null, { status: 204, headers: { Allow: ALLOW_METHODS } })
    : null;
}

/** 错误响应；OPTIONS 特判回 204（预检不炸），其余按状态码出 JSON */
function fail(req: Request, status: 502 | 503, payload: Record<string, string>): Response {
  return preflightFallback(req) ?? NextResponse.json(payload, { status });
}

/** 请求的模型配置过但没在跑：OpenAI 错误格式，客户端能直接把 message 显示给用户 */
function modelNotRunning(req: Request, model: string): Response {
  return (
    preflightFallback(req) ??
    NextResponse.json(
      {
        error: {
          message: `模型 ${model} 没有在运行，请先在面板里启动它`,
          type: "invalid_request_error",
          code: "model_not_running",
        },
      },
      { status: 404 },
    )
  );
}

/** 请求体缓冲上限（字节）：超限不读，保持零拷贝流式透传。
 *  只看 content-length 头，不为了判大小就把整个 body 读进内存；头缺失时同样按"超限"处理 */
const MAX_BUFFERED_BODY_BYTES = 4 * 1024 * 1024;

/** 命中改写白名单但因体积原因没读请求体时的诊断头文案 */
const REWRITE_SKIPPED_TOO_LARGE = "skipped (body too large)";

function withinBufferLimit(req: Request): boolean {
  const raw = req.headers.get("content-length");
  if (raw === null) return false;
  const length = Number(raw);
  return Number.isFinite(length) && length <= MAX_BUFFERED_BODY_BYTES;
}

/** 全方法统一的转发 handler（下方按 HTTP 动词导出） */
async function proxy(req: Request, ctx: { params: Promise<{ path?: string[] }> }): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const db = getDb();
  const status = await getRuntimeService().getRuntimeStatus();
  const { path } = await ctx.params;
  const method = req.method.toUpperCase();

  if (method === "GET" && isModelsListPath(path)) {
    const body = await buildAggregatedModelsList(status.models, status.defaultModel, {
      loadEffortContext: (model) => getEffortMappingContext(db, getPanelModelsRoot(), model),
    });
    return NextResponse.json(body);
  }

  const contentType = req.headers.get("content-type");
  let rawBody: string | undefined;
  let bodyTooLarge = false;
  if (method === "POST" && isJsonContentType(contentType)) {
    if (withinBufferLimit(req)) rawBody = await req.text();
    else bodyTooLarge = true;
  }

  const repo = createModelRepo(db);
  const decision = decideModelRoute({
    requested:
      (rawBody !== undefined ? extractRequestedModel(rawBody) : null) ??
      requestedModelFromQuery(new URL(req.url).searchParams),
    running: status.models.map((m) => m.model),
    defaultModel: status.defaultModel,
    isConfigured: (name) => repo.getModel(name) !== null,
  });
  if (decision.kind === "no-model") return fail(req, 503, { error: "没有运行中的模型", hint: "/models/profiles" });
  if (decision.kind === "not-running") return modelNotRunning(req, decision.model);

  const target = status.models.find((m) => m.model === decision.model);
  if (target === undefined || target.hostPort === null) {
    return fail(req, 503, { error: "运行中模型的端口未知（模型配置缺失）", hint: "/models/profiles" });
  }

  let overrideBody = rawBody;
  let effortHeader: string | null = null;
  if (isRewriteTarget(method, contentType, path)) {
    if (rawBody !== undefined) {
      const { support, config } = await getEffortMappingContext(db, getPanelModelsRoot(), decision.model);
      const result = rewriteRequestBody(rawBody, support, config);
      overrideBody = result.body;
      if (result.resolution !== null && result.requested !== undefined) {
        effortHeader = effortHeaderValue(result.requested, result.resolution);
      }
    } else if (bodyTooLarge) {
      // 没读 body，只在响应头留痕，避免客户端误以为"没有 reasoning_effort 字段"
      effortHeader = REWRITE_SKIPPED_TOO_LARGE;
    }
  }

  const { url, init } = buildProxyRequest(req, llamaUpstreamBase(target.hostPort), path, overrideBody);

  let upstream: Response;
  try {
    upstream = await fetch(url, init);
  } catch {
    // 连接拒绝 / 端口未就绪（容器刚起 llama-server 未监听）等网络层失败
    return fail(req, 502, { error: "容器端口未就绪" });
  }
  const sanitized = sanitizeUpstreamResponse(upstream);
  if (effortHeader !== null) sanitized.headers.set("x-llamapad-reasoning-effort", effortHeader);
  sanitized.headers.set("x-llamapad-model", decision.model);
  sanitized.headers.set("x-llamapad-model-route", decision.via);
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
