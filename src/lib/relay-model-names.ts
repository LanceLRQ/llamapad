import { resolveRelayDefault, type RelayUpstream } from "./relay-route";
import { isRoutable } from "./upstream-health";
import type { UpstreamView } from "./upstream-types";

/**
 * 「可用模型名」卡的数据整理（纯函数）：把托管服务与外部上游列表整理成分组行。
 *
 * 哪个名字算默认、转发到哪个模型名，都复用中转路由（relay-route.ts）的口径，不另写一份：
 * 默认走 resolveRelayDefault，别名的转发目标与 decideRelayRoute 一致（别名自己的目标优先，
 * 没有则取上游的上游模型名）。已停用的上游及其别名点名会被拒绝，不列出；不可达的上游
 * 点名仍会被转发（让客户端看到真实的连接错误），所以列出，只在状态上标红。
 * （/v1/models 为了不把死名字推给客户端，会把不可达的上游藏起来，这张卡则是面向人的全貌。）
 */

export interface ModelNameServiceInput {
  model: string;
  displayName: string;
  ready: boolean;
}

export type ModelNameUpstreamInput = Pick<
  UpstreamView,
  "name" | "displayName" | "enabled" | "state" | "isDefault" | "upstreamModel" | "aliases"
>;

export type ModelNameStatus = "ready" | "loading" | "reachable" | "unreachable" | "unknown";

export interface ModelNameRow {
  kind: "managed" | "upstream" | "alias";
  /** 请求里 model 字段要填的名字 */
  name: string;
  /** 悬停提示里的人读名称（展示名） */
  title: string;
  status: ModelNameStatus;
  isDefault: boolean;
  /** 实际转发给上游的模型名；托管模型与未登记目标的上游为 null */
  forwardsTo: string | null;
}

export interface ModelNameGroup {
  count: number;
  rows: ModelNameRow[];
}

export interface ModelNameGroups {
  managed: ModelNameGroup;
  external: ModelNameGroup;
}

function upstreamStatus(state: ModelNameUpstreamInput["state"]): ModelNameStatus {
  return state === "reachable" || state === "unreachable" ? state : "unknown";
}

export function buildModelNameGroups(input: {
  services: readonly ModelNameServiceInput[];
  upstreams: readonly ModelNameUpstreamInput[];
  /** 托管默认模型名；没有为 null */
  managedDefault: string | null;
}): ModelNameGroups {
  const routes: RelayUpstream[] = input.upstreams.map((u) => ({
    name: u.name,
    enabled: u.enabled,
    routable: isRoutable(u.state === "disabled" ? "unknown" : u.state),
    upstreamModel: u.upstreamModel,
    aliases: u.aliases,
  }));
  const defaultUpstream = input.upstreams.find((u) => u.isDefault)?.name ?? null;
  const target = resolveRelayDefault({ managedDefault: input.managedDefault, upstreams: routes, defaultUpstream }).target;

  const managed: ModelNameRow[] = input.services.map((s) => ({
    kind: "managed",
    name: s.model,
    title: s.displayName,
    status: s.ready ? "ready" : "loading",
    isDefault: target?.kind === "managed" && target.name === s.model,
    forwardsTo: null,
  }));

  const external: ModelNameRow[] = input.upstreams
    .filter((u) => u.enabled)
    .flatMap((u) => {
      const status = upstreamStatus(u.state);
      const upstreamRow: ModelNameRow = {
        kind: "upstream",
        name: u.name,
        title: u.displayName,
        status,
        isDefault: target?.kind === "external" && target.name === u.name,
        forwardsTo: u.upstreamModel,
      };
      const aliasRows = u.aliases.map(
        (a): ModelNameRow => ({
          kind: "alias",
          name: a.alias,
          title: u.displayName,
          status,
          isDefault: false,
          forwardsTo: a.upstreamModel ?? u.upstreamModel,
        }),
      );
      return [upstreamRow, ...aliasRows];
    });

  return { managed: { count: managed.length, rows: managed }, external: { count: external.length, rows: external } };
}
