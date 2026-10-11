import { NextResponse } from "next/server";
import { extractRequestedModel, requestedModelFromQuery } from "@/lib/model-route";
import { appendExternalModels } from "@/lib/models-list";
import { readBoundedBodyText } from "@/lib/proxy-body";
import {
  effortHeaderValue,
  isJsonContentType,
  isModelsListPath,
  isRewriteTarget,
  rewriteRequestBody,
} from "@/lib/proxy-rewrite";
import { decideRelayRoute } from "@/lib/relay-route";
import { applyUpstreamModel } from "@/lib/upstream-forward";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getEffortMappingContext } from "@/server/effortContext";
import { buildProxyRequest, llamaUpstreamBase, sanitizeUpstreamResponse } from "@/server/llamaProxy";
import { getPanelModelsRoot, getRuntimeService, getUpstreamMonitor } from "@/server/locators";
import { buildAggregatedModelsList } from "@/server/modelsListProxy";
import { effectiveDefault, loadRelayContext, routeInputOf } from "@/server/relayRouting";

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
 * 发往哪个模型（决策 D6，判定在 lib/relay-route.ts）：
 * - JSON POST 读请求体的 model 字段；GET 等无体请求读查询串 `?model=`
 * - 请求的模型在跑 → 发往它；面板里配置过但没在跑 → 404（OpenAI 错误格式，
 *   code: model_not_running）；面板不认识的名字或没带 → 默认模型
 * - 响应头 x-llamapad-model 标注实际目标，x-llamapad-model-route 标注原因
 *   （requested / default / fallback-default）
 *
 * 外部上游（不由面板启停的 OpenAI 兼容服务，见 server/repo/upstreams.ts）与托管模型
 * 共用这一个入口：路由判定在 lib/relay-route.ts。发往外部上游时注入它自己的密钥、
 * 按登记改写 model 字段，不做思考强度改写；连接失败 → 502 `{error:"上游不可达"}`。
 * x-llamapad-model-route 在原有三个取值外多一个 fallback-unreachable：
 * 默认上游不可达，本次临时改发到托管模型。
 * 点名已停用的上游 → 404（OpenAI 错误格式，code: upstream_disabled）。
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
 * 启用且未被判为不可达的外部上游按登记名追加在后（生效默认是外部上游时它排第一）。
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

/** 点名了一个已停用的外部上游：OpenAI 错误格式 */
function upstreamDisabled(req: Request, upstream: string): Response {
  return (
    preflightFallback(req) ??
    NextResponse.json(
      {
        error: {
          message: `外部上游 ${upstream} 已停用，请先在面板的 API 中转页启用它`,
          type: "invalid_request_error",
          code: "upstream_disabled",
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
  const monitor = getUpstreamMonitor();
  const relay = await loadRelayContext(db, getRuntimeService(), monitor);
  const { status } = relay;
  const { path } = await ctx.params;
  const method = req.method.toUpperCase();

  if (method === "GET" && isModelsListPath(path)) {
    const managed = await buildAggregatedModelsList(status.models, status.defaultModel, {
      loadEffortContext: (model) => getEffortMappingContext(db, getPanelModelsRoot(), model),
    });
    // 列表的语义是「现在能用的」：停用与被判为不可达的上游不列出
    const externals = relay.routes.filter((u) => u.enabled && u.routable).map((u) => u.name);
    return NextResponse.json(appendExternalModels(managed, externals, effectiveDefault(relay).name));
  }

  const contentType = req.headers.get("content-type");
  let rawBody: string | undefined;
  if (method === "POST" && isJsonContentType(contentType)) {
    const bodyResult = await readBoundedBodyText(req.body, MAX_BODY_BYTES);
    if (!bodyResult.ok) return requestTooLarge(req);
    rawBody = bodyResult.text;
  }

  const requested =
    (rawBody !== undefined ? extractRequestedModel(rawBody) : null) ??
    requestedModelFromQuery(new URL(req.url).searchParams);
  const decision = decideRelayRoute(routeInputOf(relay, db, requested));
  if (decision.kind === "no-model") return fail(req, 503, { error: "没有运行中的模型", hint: "/models/profiles" });
  if (decision.kind === "not-running") return modelNotRunning(req, decision.model);
  if (decision.kind === "upstream-disabled") return upstreamDisabled(req, decision.upstream);

  // 默认上游不可达导致本次降级：后台激活一次探测（限频），不等它
  if (decision.activate !== null) monitor.activate(decision.activate);

  if (decision.target.kind === "external") {
    const name = decision.target.name;
    const external = relay.upstreams.find((u) => u.name === name);
    if (external === undefined) return fail(req, 503, { error: "外部上游配置缺失" });

    const body =
      rawBody !== undefined && external.upstreamModel !== null
        ? applyUpstreamModel(rawBody, external.upstreamModel)
        : rawBody;
    const { url, init } = buildProxyRequest(req, external.baseUrl, path, body);
    // buildProxyRequest 已剥掉客户端带来的面板凭证，这里换成上游自己的密钥
    if (external.apiKey !== null) (init.headers as Headers).set("authorization", `Bearer ${external.apiKey}`);

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      // 客户端自己断开也会让 fetch 抛错，那不是上游的问题，不计入失败
      if (!req.signal.aborted) monitor.report(name, false, error instanceof Error ? error.message : String(error));
      return fail(req, 502, { error: "上游不可达" });
    }
    monitor.report(name, true);
    const sanitized = sanitizeUpstreamResponse(response);
    sanitized.headers.set("x-llamapad-model", name);
    sanitized.headers.set("x-llamapad-model-route", decision.via);
    return sanitized;
  }

  const model = decision.target.name;
  const target = status.models.find((m) => m.model === model);
  if (target === undefined || target.hostPort === null) {
    return fail(req, 503, { error: "运行中模型的端口未知（模型配置缺失）", hint: "/models/profiles" });
  }

  let overrideBody = rawBody;
  let effortHeader: string | null = null;
  if (isRewriteTarget(method, contentType, path) && rawBody !== undefined) {
    const { support, config } = await getEffortMappingContext(db, getPanelModelsRoot(), model);
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
  sanitized.headers.set("x-llamapad-model", model);
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
