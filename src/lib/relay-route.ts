/**
 * API 中转的路由表（纯函数）：把运行中的托管模型与启用的外部上游合成候选目标，
 * 决定一次请求发往谁。取代 lib/model-route.ts 里只认托管模型的 decideModelRoute。
 *
 * 点名规则沿用多模型并行时定下的原则（决策 D6）：点了名就发往它，发不了就明确报错，
 * 绝不静默改发——那会让用户以为在和 A 对话，实际回答来自 B。外部上游同理：点名一个
 * 不可达的上游照样发过去，让客户端看到真实的连接错误。
 *
 * 只有「没点名」或「点的名字面板不认识」的请求才走默认。默认上游不可达时降级到
 * 托管模型，是这张表里唯一会自动换目标的地方，并用 via: fallback-unreachable 标出来。
 */

export interface RelayUpstream {
  name: string;
  enabled: boolean;
  /** 存活状态是否允许作为默认目标（unknown 与 reachable 为 true） */
  routable: boolean;
  /** 上游登记的上游模型名；转发时写进请求体的 model，null 表示原样透传 */
  upstreamModel: string | null;
  /** 别名，按存储顺序；点名别名发往本上游 */
  aliases: readonly { alias: string; upstreamModel: string | null }[];
}

export interface RelayRouteInput {
  /** 请求里的 model；没带为 null */
  requested: string | null;
  /** 运行中的托管模型名 */
  running: readonly string[];
  /** runtime 决议出的托管默认模型；没有模型在跑为 null */
  managedDefault: string | null;
  /** 该名字是否是面板里配置过的托管模型 */
  isConfiguredModel: (name: string) => boolean;
  /** 全部外部上游（含已停用的，点名停用的上游要给出明确错误） */
  upstreams: readonly RelayUpstream[];
  /** 用户显式设为默认的上游名；未设置为 null */
  defaultUpstream: string | null;
}

export type RelayTarget =
  | { kind: "managed"; name: string }
  /** forwardModel：本次要写进请求体的上游模型名；null 表示请求体原样透传 */
  | { kind: "external"; name: string; forwardModel: string | null };

export type RelayRouteVia = "requested" | "default" | "fallback-default" | "fallback-unreachable";

export type RelayRouteDecision =
  | {
      kind: "route";
      target: RelayTarget;
      via: RelayRouteVia;
      /** 需要激活一次后台探测的上游名（默认上游不可达导致本次降级时）；否则 null */
      activate: string | null;
    }
  | { kind: "not-running"; model: string }
  | { kind: "upstream-disabled"; upstream: string }
  | { kind: "no-model" };

export interface RelayDefault {
  target: RelayTarget | null;
  /** 本该接收默认流量、但因不可达被跳过的上游名；没有降级为 null */
  degradedFrom: string | null;
}

function externalTarget(upstream: RelayUpstream, forwardModel: string | null = upstream.upstreamModel): RelayTarget {
  return { kind: "external", name: upstream.name, forwardModel };
}

/**
 * /v1/models 要列出的外部名字：每个启用且未被判为不可达的上游，
 * 自己的名字之后紧跟它的全部别名（按存储顺序）。
 */
export function externalModelNames(upstreams: readonly RelayUpstream[]): string[] {
  return upstreams
    .filter((u) => u.enabled && u.routable)
    .flatMap((u) => [u.name, ...u.aliases.map((a) => a.alias)]);
}

/**
 * 决议生效的默认目标：
 * 1. 默认上游启用且可用 → 它
 * 2. 有托管默认模型 → 它（第 1 步是因为不可达被跳过时，记下 degradedFrom）
 * 3. 默认上游启用但不可达、又没有托管模型可降级 → 仍是它，让客户端看到真实错误
 * 4. 否则没有默认目标
 */
export function resolveRelayDefault(
  input: Pick<RelayRouteInput, "managedDefault" | "upstreams" | "defaultUpstream"> & Partial<RelayRouteInput>,
): RelayDefault {
  const upstream =
    input.defaultUpstream !== null
      ? input.upstreams.find((u) => u.name === input.defaultUpstream && u.enabled)
      : undefined;

  if (upstream?.routable) return { target: externalTarget(upstream), degradedFrom: null };
  if (input.managedDefault !== null) {
    return { target: { kind: "managed", name: input.managedDefault }, degradedFrom: upstream?.name ?? null };
  }
  if (upstream !== undefined) return { target: externalTarget(upstream), degradedFrom: null };
  return { target: null, degradedFrom: null };
}

export function decideRelayRoute(input: RelayRouteInput): RelayRouteDecision {
  const { requested } = input;

  if (requested !== null) {
    if (input.running.includes(requested)) {
      return { kind: "route", target: { kind: "managed", name: requested }, via: "requested", activate: null };
    }
    const upstream = input.upstreams.find((u) => u.name === requested);
    if (upstream !== undefined) {
      return upstream.enabled
        ? { kind: "route", target: externalTarget(upstream), via: "requested", activate: null }
        : { kind: "upstream-disabled", upstream: requested };
    }
    for (const owner of input.upstreams) {
      const alias = owner.aliases.find((a) => a.alias === requested);
      if (alias === undefined) continue;
      return owner.enabled
        ? {
            kind: "route",
            target: externalTarget(owner, alias.upstreamModel ?? owner.upstreamModel),
            via: "requested",
            activate: null,
          }
        : { kind: "upstream-disabled", upstream: owner.name };
    }
    if (input.isConfiguredModel(requested)) return { kind: "not-running", model: requested };
  }

  const fallback = resolveRelayDefault(input);
  if (fallback.target === null) return { kind: "no-model" };

  const via: RelayRouteVia =
    fallback.degradedFrom !== null ? "fallback-unreachable" : requested === null ? "default" : "fallback-default";
  return { kind: "route", target: fallback.target, via, activate: fallback.degradedFrom };
}
