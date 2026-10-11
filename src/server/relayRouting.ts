import type Database from "better-sqlite3";
import { resolveRelayDefault, type RelayRouteInput, type RelayUpstream } from "../lib/relay-route";
import { isRoutable, type UpstreamHealth } from "../lib/upstream-health";
import { createModelRepo } from "./repo/models";
import { getDefaultUpstream, listUpstreams, type StoredUpstream } from "./repo/upstreams";
import type { RuntimeService, RuntimeStatus } from "./runtime";

/**
 * 路由上下文的 IO 装配：把 runtime 的运行状态、上游表、存活状态读到一起，
 * 交给 lib/relay-route.ts 的纯函数决议。中转 route 与默认模型、运行状态两个接口共用，
 * 保证三处看到的「生效默认」是同一个算法算出来的。
 */

/** 只依赖 snapshot，方便测试里用字面量对象替身 */
export interface HealthSource {
  snapshot(name: string): UpstreamHealth;
}

export interface RelayContext {
  status: RuntimeStatus;
  upstreams: StoredUpstream[];
  /** 与 upstreams 同序的路由视图（启用状态 + 是否可作为默认目标） */
  routes: RelayUpstream[];
  defaultUpstream: string | null;
}

export async function loadRelayContext(
  db: Database.Database,
  runtime: RuntimeService,
  health: HealthSource,
): Promise<RelayContext> {
  const status = await runtime.getRuntimeStatus();
  const upstreams = listUpstreams(db);
  return {
    status,
    upstreams,
    routes: upstreams.map((upstream) => ({
      name: upstream.name,
      enabled: upstream.enabled,
      routable: isRoutable(health.snapshot(upstream.name).state),
    })),
    defaultUpstream: getDefaultUpstream(db),
  };
}

export function routeInputOf(ctx: RelayContext, db: Database.Database, requested: string | null): RelayRouteInput {
  const repo = createModelRepo(db);
  return {
    requested,
    running: ctx.status.models.map((m) => m.model),
    managedDefault: ctx.status.defaultModel,
    isConfiguredModel: (name) => repo.getModel(name) !== null,
    upstreams: ctx.routes,
    defaultUpstream: ctx.defaultUpstream,
  };
}

export interface EffectiveDefault {
  name: string | null;
  kind: "managed" | "external" | null;
  /** 默认上游不可达、流量被临时改发到托管模型 */
  degraded: boolean;
}

export function effectiveDefault(ctx: RelayContext): EffectiveDefault {
  const resolved = resolveRelayDefault({
    managedDefault: ctx.status.defaultModel,
    upstreams: ctx.routes,
    defaultUpstream: ctx.defaultUpstream,
  });
  return {
    name: resolved.target?.name ?? null,
    kind: resolved.target?.kind ?? null,
    degraded: resolved.degradedFrom !== null,
  };
}
