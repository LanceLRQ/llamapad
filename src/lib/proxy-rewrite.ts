import { resolveEffort, type EffortMappingConfig, type EffortOutcome, type EffortResolution } from "./effort-mapping";
import type { EffortSupport } from "./reasoning-effort";

/**
 * 「思考强度中转映射」接线层纯函数（最后一批）
 *
 * effort-mapping.ts 只回答"这个值该改写成什么"，本文件回答"该不该动这个请求 /
 * 怎么把改写结果嵌回 JSON 请求体 / 怎么把决议变成人能看懂的响应头 / 怎么在
 * /v1/models 上声明这个模型支不支持这个参数"——四件事分别对应下面四个导出函数，
 * 组装 EffortSupport/EffortMappingConfig 上下文与实际发请求的编排留在
 * server/effortContext.ts 与 route 薄壳（本文件不碰 IO）。
 */

/** 需要改写请求体的路径（catch-all 段数组形态，需同时兼容带/不带 v1 前缀两种写法） */
const REWRITE_PATHS: readonly (readonly string[])[] = [
  ["v1", "chat", "completions"],
  ["chat", "completions"],
  ["apply-template"],
];

/** /v1/models 的两种等价路径（llama.cpp 原生支持不带 v1 前缀的别名，返回内容相同） */
const MODELS_LIST_PATHS: readonly (readonly string[])[] = [
  ["v1", "models"],
  ["models"],
];

/** Next 可选 catch-all 的段数组里可能混入空串（根路径场景），与 buildUpstreamPath 同款处理 */
function normalizeSegments(pathSegments: string[] | undefined): string[] {
  return (pathSegments ?? []).filter((segment) => segment !== "");
}

function matchesAny(segments: string[], candidates: readonly (readonly string[])[]): boolean {
  return candidates.some(
    (candidate) => candidate.length === segments.length && candidate.every((seg, i) => seg === segments[i]),
  );
}

/**
 * 判定这一次请求是否需要改写 reasoning_effort：必须同时满足
 * POST + content-type 为 JSON（允许带 charset 等参数） + 路径命中白名单三者。
 * 其余一律不改写——包括 GET（无请求体）、非 JSON（改了也读不出字段）、
 * 白名单之外的路径（如 /completion 走的是别的字段名，不在本特性范围内）。
 */
export function isRewriteTarget(
  method: string,
  contentType: string | null,
  pathSegments: string[] | undefined,
): boolean {
  if (method.toUpperCase() !== "POST") return false;
  if (contentType === null) return false;
  const mimeType = contentType.split(";")[0].trim().toLowerCase();
  if (mimeType !== "application/json") return false;
  return matchesAny(normalizeSegments(pathSegments), REWRITE_PATHS);
}

/** GET /v1/models 与其别名 GET /models 命中判定（响应增强走这条，不走请求体改写） */
export function isModelsListPath(pathSegments: string[] | undefined): boolean {
  return matchesAny(normalizeSegments(pathSegments), MODELS_LIST_PATHS);
}

/** rewriteRequestBody 的返回形态 */
export interface RewriteBodyResult {
  /** 改写后的请求体；未发生改写时与传入的 rawBody 完全一致（同一字符串） */
  body: string;
  /** 本次决议；字段不存在/类型不对/JSON 解不开时为 null，表示"没有判断依据，什么都没做" */
  resolution: EffortResolution | null;
  /**
   * 客户端原始传入的 reasoning_effort 值；仅 resolution 非 null 时有意义。
   * 单独带出来是为了给调用方（route 编排层）生成 x-llamapad-reasoning-effort
   * 响应头用——effortHeaderValue 的文案里需要"客户端原来发的是什么"，让 route
   * 侧另行解析一遍 JSON 纯属重复劳动，不如在这唯一一处解析里顺带带出。
   */
  requested?: string;
}

/**
 * 按「思考强度中转映射」规则改写请求体里的 reasoning_effort 字段。
 *
 * 兜底策略贯穿全部分支：只要没有足够把握判断该怎么改，就原样返回——
 * JSON 解析失败、根不是对象、字段不存在、字段类型不对，统统落到"不动"，
 * 面板绝不能因为自己看不懂请求体而让一次推理请求失败。
 */
export function rewriteRequestBody(
  rawBody: string,
  support: EffortSupport,
  config: EffortMappingConfig,
): RewriteBodyResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { body: rawBody, resolution: null };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { body: rawBody, resolution: null };
  }

  const obj = parsed as Record<string, unknown>;
  if (!("reasoning_effort" in obj)) {
    return { body: rawBody, resolution: null };
  }
  const requested = obj.reasoning_effort;
  if (typeof requested !== "string") {
    return { body: rawBody, resolution: null };
  }

  const resolution = resolveEffort(requested, support, config);
  if (resolution.outcome === "dropped") {
    delete obj.reasoning_effort;
  } else {
    obj.reasoning_effort = resolution.value;
  }
  return { body: JSON.stringify(obj), resolution, requested };
}

/** outcome → 响应头里给人看的诊断词；dropped 没有 value 可展示，用固定词"dropped"占位 */
const OUTCOME_LABELS: Record<EffortOutcome, string> = {
  passthrough: "passthrough",
  alias: "alias",
  "rounded-down": "rounded-down",
  "rounded-up": "rounded-up",
  dropped: "unsupported",
};

/**
 * 把一次决议变成一行可读诊断，形如 "max->xhigh (alias)" / "banana->dropped (unsupported)"。
 * 头名固定为 x-llamapad-reasoning-effort（由调用方设置，本函数只产出文案）。
 */
export function effortHeaderValue(requested: string, resolution: EffortResolution): string {
  const target = resolution.value ?? "dropped";
  return `${requested}->${target} (${OUTCOME_LABELS[resolution.outcome]})`;
}

/** enhanceModelsResponse 内部拼进每个 data[] 条目的新增字段 */
function buildExtraFields(support: EffortSupport, config: EffortMappingConfig) {
  const supported = support.state === "supported";
  return {
    supported_parameters: supported ? ["reasoning_effort"] : [],
    x_llamapad: {
      reasoning_effort: {
        supported,
        levels: support.levels,
        aliases: config.aliases,
        rounding: config.rounding,
      },
    },
  };
}

/**
 * 增强 /v1/models（及别名 /models）的上游响应：给 data[] 每一项只增不改地补
 * supported_parameters（跟随 OpenRouter 惯例的能力声明数组）与 x_llamapad
 * （面板自己的诊断信息），让客户端（Cherry Studio 等）有机会据此调整自己发送的
 * reasoning_effort。上游响应结构不符合预期（JSON 解不开、data 不是数组）时
 * 原样返回——这条增强是锦上添花，不能因为解析失败连模型列表都拿不到。
 */
export function enhanceModelsResponse(
  rawBody: string,
  support: EffortSupport,
  config: EffortMappingConfig,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return rawBody;
  }
  const root = parsed as Record<string, unknown>;
  if (!Array.isArray(root.data)) {
    return rawBody;
  }

  const extra = buildExtraFields(support, config);
  const data = root.data.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
    return { ...item, ...extra };
  });

  return JSON.stringify({ ...root, data });
}
