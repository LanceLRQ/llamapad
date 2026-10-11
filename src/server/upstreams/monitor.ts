import {
  INITIAL_HEALTH,
  PROBE_INTERVAL_MS,
  PROBE_TIMEOUT_MS,
  applyOutcome,
  canActivate,
  markActivated,
  shouldPoll,
  transitionOf,
  type ProbeOutcome,
  type UpstreamHealth,
} from "../../lib/upstream-health";

/**
 * 外部上游的探测与调度（进程内单例，经 locators.getUpstreamMonitor 取用）。
 *
 * 状态机在 lib/upstream-health.ts，这里只负责「什么时候探测」与发请求：
 * - 可达 / 未知：每 PROBE_INTERVAL_MS 探测一次
 * - 不可达：不再定时探测，由 activate（降级请求 / 打开中转页）或 probeNow（测试连接）触发
 * - 点名转发的结果经 report 直接进状态机，不另发探测
 *
 * 状态只在内存里，面板重启后全部回到 unknown。
 */

export interface MonitorTarget {
  name: string;
  baseUrl: string;
  apiKey: string | null;
}

export interface ProbeResult {
  /** 是否拿到了 HTTP 响应（不论状态码） */
  ok: boolean;
  /** 上游的 HTTP 状态码；网络层失败为 null */
  status: number | null;
  latencyMs: number;
  /** 上游 /v1/models 返回的模型 id；非 200 或解析不了为空数组 */
  models: string[];
  error: string | null;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function modelIdsOf(json: unknown): string[] {
  if (typeof json !== "object" || json === null) return [];
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data
    .map((item) => (typeof item === "object" && item !== null ? (item as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string" && id !== "");
}

/** 探测一次：GET <baseUrl>/v1/models。不改任何状态，monitor 与「保存前测试」共用 */
export async function probeUpstream(
  target: Pick<MonitorTarget, "baseUrl" | "apiKey">,
  fetchImpl: FetchLike = fetch,
): Promise<ProbeResult> {
  const startedAt = Date.now();
  const headers = new Headers({ accept: "application/json" });
  if (target.apiKey !== null) headers.set("authorization", `Bearer ${target.apiKey}`);

  let response: Response;
  try {
    response = await fetchImpl(`${target.baseUrl}/v1/models`, {
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      status: null,
      latencyMs: Date.now() - startedAt,
      models: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const json: unknown = response.ok ? await response.json().catch(() => null) : null;
  return {
    ok: true,
    status: response.status,
    latencyMs: Date.now() - startedAt,
    models: modelIdsOf(json),
    error: null,
  };
}

export interface UpstreamMonitorDeps {
  /** 当前启用的上游（每次调用都重新取，停用与删除即时生效） */
  listEnabled: () => MonitorTarget[];
  fetch?: FetchLike;
  now?: () => number;
  /** 进入不可达 / 从不可达恢复时回调一次（写事件表用）；抛错不影响探测 */
  onTransition?: (name: string, to: "unreachable" | "recovered") => void;
}

export interface UpstreamMonitor {
  /** 开始定时探测；幂等 */
  start(): void;
  stop(): void;
  /** 某个上游当前的状态；没探测过返回初始状态（unknown） */
  snapshot(name: string): UpstreamHealth;
  /** 把一次转发的连接结果喂给状态机 */
  report(name: string, ok: boolean, error?: string): void;
  /** 由请求激活一次后台探测（限频）；不等待结果 */
  activate(name: string): void;
  /** 立即探测并更新状态；上游未登记或已停用返回 null */
  probeNow(name: string): Promise<ProbeResult | null>;
}

export function createUpstreamMonitor(deps: UpstreamMonitorDeps): UpstreamMonitor {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const health = new Map<string, UpstreamHealth>();
  /** 正在探测中的上游：定时轮次与请求激活可能撞在一起，同一时刻只发一个 */
  const inFlight = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;

  function snapshot(name: string): UpstreamHealth {
    return health.get(name) ?? INITIAL_HEALTH;
  }

  function apply(name: string, outcome: ProbeOutcome): void {
    const before = snapshot(name);
    const after = applyOutcome(before, outcome, now());
    health.set(name, after);
    const transition = transitionOf(before, after);
    if (transition !== null) {
      try {
        deps.onTransition?.(name, transition);
      } catch {
        // 事件记录失败不该连累探测本身
      }
    }
  }

  async function probe(target: MonitorTarget): Promise<ProbeResult> {
    const result = await probeUpstream(target, fetchImpl);
    apply(target.name, result.ok ? { ok: true } : { ok: false, error: result.error ?? "unknown" });
    return result;
  }

  async function probeOnce(target: MonitorTarget): Promise<void> {
    if (inFlight.has(target.name)) return;
    inFlight.add(target.name);
    try {
      await probe(target);
    } finally {
      inFlight.delete(target.name);
    }
  }

  function tick(): void {
    const targets = deps.listEnabled();
    const enabled = new Set(targets.map((t) => t.name));
    for (const name of health.keys()) {
      if (!enabled.has(name)) health.delete(name);
    }
    for (const target of targets) {
      if (shouldPoll(snapshot(target.name).state)) void probeOnce(target);
    }
  }

  return {
    start() {
      if (timer !== null) return;
      timer = setInterval(tick, PROBE_INTERVAL_MS);
      // 不让这个定时器拖住进程退出（测试与 next build 的收尾都依赖这一点）
      timer.unref?.();
    },
    stop() {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
    snapshot,
    report(name, ok, error) {
      apply(name, ok ? { ok: true } : { ok: false, error: error ?? "unknown" });
    },
    activate(name) {
      const target = deps.listEnabled().find((t) => t.name === name);
      if (target === undefined) return;
      const current = snapshot(name);
      if (!canActivate(current, now())) return;
      health.set(name, markActivated(current, now()));
      void probeOnce(target);
    },
    async probeNow(name) {
      const target = deps.listEnabled().find((t) => t.name === name);
      if (target === undefined) return null;
      return probe(target);
    },
  };
}
