/**
 * API 中转的模型路由决策（多模型并行，决策 D6）
 *
 * 单模型时代请求体里的 model 字段不参与路由，客户端填什么都打到唯一在跑的模型上。
 * 多模型下改为：
 * - 请求的模型在跑 → 发往它
 * - 请求的是面板里配置过、但当前没在跑的模型 → 明确报错。静默改发到默认模型会让
 *   用户以为自己在和 A 对话，实际回答来自 B
 * - 请求的名字面板不认识 → 回落默认模型。不少客户端把 model 写死成 gpt-4o 之类的
 *   占位值，单模型时代这些客户端一直能用，不能因为升级而全部报错
 * - 不带 model → 默认模型
 *
 * 本文件不碰 IO：running / defaultModel 由 route 从 runtime 状态取，
 * isConfigured 由 route 包一层 repo 查询传入。
 */

/** 从 JSON 请求体取 model 字段；取不到（非 JSON、非对象、字段缺失/空白/非字符串）返回 null */
export function extractRequestedModel(rawBody: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const value = (parsed as Record<string, unknown>).model;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** GET / HEAD 等无请求体的调用从查询串 ?model= 取（llama-server 的 router 模式也用这个参数名） */
export function requestedModelFromQuery(params: URLSearchParams): string | null {
  const trimmed = params.get("model")?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

export type ModelRouteDecision =
  | { kind: "route"; model: string; via: "requested" | "default" | "fallback-default" }
  | { kind: "not-running"; model: string }
  | { kind: "no-model" };

export interface ModelRouteInput {
  requested: string | null;
  /** 运行中的模型名 */
  running: readonly string[];
  /** 当前默认模型；running 非空时一定非空（runtime 已决议过） */
  defaultModel: string | null;
  /** 该名字是否是面板里配置过的模型 */
  isConfigured: (name: string) => boolean;
}

export function decideModelRoute(input: ModelRouteInput): ModelRouteDecision {
  const { requested, running, defaultModel } = input;
  if (requested !== null && running.includes(requested)) {
    return { kind: "route", model: requested, via: "requested" };
  }
  if (requested !== null && input.isConfigured(requested)) {
    return { kind: "not-running", model: requested };
  }
  if (defaultModel === null) return { kind: "no-model" };
  return { kind: "route", model: defaultModel, via: requested === null ? "default" : "fallback-default" };
}
