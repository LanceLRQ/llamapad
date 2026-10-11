/**
 * 外部上游存活状态机（纯函数）。
 *
 * 「成功」的口径是拿到了 HTTP 响应，不论状态码：上游回 401 / 404 / 500 说明服务在线，
 * 密钥或路径问题不该让它被判为不可达。只有网络层失败与超时算失败。
 *
 * 不可达后停止定时探测是有意的：外部上游可能长时间离线，对着一个死地址每 15 秒
 * 请求一次没有意义。恢复靠请求激活（见 server/upstreams/monitor.ts）。
 */

export type UpstreamHealthState = "unknown" | "reachable" | "unreachable";

export interface UpstreamHealth {
  state: UpstreamHealthState;
  /** 连续失败次数；成功即清零 */
  failures: number;
  /** 最近一次探测或转发得出结论的时间（毫秒）；从未有过为 null */
  lastCheckedAt: number | null;
  /** 最近一次失败的原因；最近一次是成功则为 null */
  lastError: string | null;
  /** 最近一次由请求激活探测的时间（限频用） */
  lastActivatedAt: number | null;
}

/** 连续失败多少次转为不可达 */
export const FAILURE_THRESHOLD = 3;
/** 定时探测间隔，也是请求激活的限频窗口 */
export const PROBE_INTERVAL_MS = 15_000;
/** 单次探测超时 */
export const PROBE_TIMEOUT_MS = 3_000;

export const INITIAL_HEALTH: UpstreamHealth = {
  state: "unknown",
  failures: 0,
  lastCheckedAt: null,
  lastError: null,
  lastActivatedAt: null,
};

export type ProbeOutcome = { ok: true } | { ok: false; error: string };

export function applyOutcome(health: UpstreamHealth, outcome: ProbeOutcome, now: number): UpstreamHealth {
  if (outcome.ok) {
    return { ...health, state: "reachable", failures: 0, lastCheckedAt: now, lastError: null };
  }
  const failures = health.failures + 1;
  return {
    ...health,
    state: failures >= FAILURE_THRESHOLD ? "unreachable" : health.state,
    failures,
    lastCheckedAt: now,
    lastError: outcome.error,
  };
}

/** 值得写进事件表的状态变化：进入不可达、从不可达恢复。unknown → reachable 不算 */
export function transitionOf(before: UpstreamHealth, after: UpstreamHealth): "unreachable" | "recovered" | null {
  if (before.state !== "unreachable" && after.state === "unreachable") return "unreachable";
  if (before.state === "unreachable" && after.state === "reachable") return "recovered";
  return null;
}

/** 是否参与定时探测 */
export function shouldPoll(state: UpstreamHealthState): boolean {
  return state !== "unreachable";
}

/** 路由上是否当作可用。unknown（面板刚启动还没探测过）按可用处理，不让重启造成一轮误降级 */
export function isRoutable(state: UpstreamHealthState): boolean {
  return state !== "unreachable";
}

export function canActivate(health: UpstreamHealth, now: number): boolean {
  return health.lastActivatedAt === null || now - health.lastActivatedAt >= PROBE_INTERVAL_MS;
}

export function markActivated(health: UpstreamHealth, now: number): UpstreamHealth {
  return { ...health, lastActivatedAt: now };
}
