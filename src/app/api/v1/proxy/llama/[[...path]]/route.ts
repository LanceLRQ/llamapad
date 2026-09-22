import { NextResponse } from "next/server";
import { decideModelRoute, extractRequestedModel, requestedModelFromQuery } from "@/lib/model-route";
import { readBoundedBodyText } from "@/lib/proxy-body";
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
 * 请求体读取：JSON POST 一律按实际读到的字节数流式读完（lib/proxy-body.ts，
 * 不看 content-length——缺失或撒谎都不影响判断），上限 64MB，读到的正文既用来取
 * model，也给「思考强度中转映射」改写（白名单路径 /v1/chat/completions、
 * /chat/completions、/apply-template）；超过 64MB 中止读取，直接 413（OpenAI
 * 错误格式，code: request_too_large），不再有「跳过改写、静默按不带 model 处理」
 * 的中间态（旧实现的缺陷正在这——大请求体会被误发到默认模型）。
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
 * - 请求体超过 64MB → 413 `{error:{message, type:"invalid_request_error", code:"request_too_large"}}`
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

/** JSON POST 请求体读取上限（字节）：不看 content-length，按实际读到的字节数中止 */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** 请求体超过 MAX_BODY_BYTES：OpenAI 错误格式，客户端能直接把 message 显示给用户 */
function requestTooLarge(req: Request): Response {
  return (
    preflightFallback(req) ??
    NextResponse.json(
      {
        error: {
          message: "请求体超过 64MB 上限",
          type: "invalid_request_error",
          code: "request_too_large",
        },
      },
      { status: 413 },
    )
  );
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
  if (method === "POST" && isJsonContentType(contentType)) {
    const bodyResult = await readBoundedBodyText(req.body, MAX_BODY_BYTES);
    if (!bodyResult.ok) return requestTooLarge(req);
    rawBody = bodyResult.text;
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
  if (isRewriteTarget(method, contentType, path) && rawBody !== undefined) {
    const { support, config } = await getEffortMappingContext(db, getPanelModelsRoot(), decision.model);
    const result = rewriteRequestBody(rawBody, support, config);
    overrideBody = result.body;
    if (result.resolution !== null && result.requested !== undefined) {
      effortHeader = effortHeaderValue(result.requested, result.resolution);
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
