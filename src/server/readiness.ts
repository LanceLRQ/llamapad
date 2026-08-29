import { llamaUpstreamBase } from "@/server/llamaProxy";

/**
 * 模型就绪探测（真机缺陷修复：容器起来 ≠ llama-server 已监听）
 *
 * runtime.ts 的 adapter.start 只等"容器连续 10 秒没退出"就判定启动成功，
 * 但 llama-server 还要把模型文件读进显存才会真正开始监听端口。真机实测
 * 一个 27B 模型：容器启动到面板记"启动成功"仅 10s，但 listening on
 * 0.0.0.0:8080 出现在 34s 之后——中间这段窗口面板显示"运行中"、Chat 页
 * 照常渲染 iframe，用户看到的却是浏览器的连接失败页。
 *
 * 探测口径与 metrics/health.ts 的存活探测同源：打
 * `${llamaUpstreamBase(hostPort)}/health`，200 才算就绪；非 200、抛错、
 * 超时都只代表"还没好"，不向外抛异常（探测失败不是错误，是常态）。
 *
 * 超时比 health.ts 的 3s 采集超时更短——就绪探测挂在 UI 高频轮询路径上
 * （Chat 加载态 / 启动弹窗都是 2s 一次），探测本身拖太久会拖慢轮询节拍。
 */
const PROBE_TIMEOUT_MS = 1_500;

/** 缓存 TTL：decorateRuntimeStatus 被状态栏 / 概览 / Chat 页 / 日志流 /
 * container-stats 多处调用，不缓存会把每次页面渲染都放大成一次探测；2s 又
 * 足够让"刚加载完"在两个轮询周期内被看到（Chat 加载态与启动弹窗都是 2s 轮询）。 */
const CACHE_TTL_MS = 2_000;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ReadinessProbeDeps {
  fetch?: FetchLike;
  now?: () => number;
}

export interface ReadinessProbe {
  isReady(hostPort: number): Promise<boolean>;
}

/** 缓存项：连探测中的 promise 也存进去，防止同一 hostPort 短时间内被并发
 * 调用时重复发起请求（惊群）；结果落定后该 promise 就是最终值，继续复用到 TTL 到期 */
interface CacheEntry {
  promise: Promise<boolean>;
  fetchedAt: number;
}

export function createReadinessProbe(deps: ReadinessProbeDeps = {}): ReadinessProbe {
  const fetchImpl: FetchLike = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const cache = new Map<number, CacheEntry>();

  async function probe(hostPort: number): Promise<boolean> {
    try {
      const res = await fetchImpl(`${llamaUpstreamBase(hostPort)}/health`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  return {
    isReady(hostPort: number): Promise<boolean> {
      const cached = cache.get(hostPort);
      if (cached !== undefined && now() - cached.fetchedAt < CACHE_TTL_MS) {
        return cached.promise;
      }
      const entry: CacheEntry = { promise: probe(hostPort), fetchedAt: now() };
      cache.set(hostPort, entry);
      return entry.promise;
    },
  };
}

/** 应用侧单例（模块级缓存，所有调用方共享一次探测结果） */
const sharedProbe = createReadinessProbe();

export function probeReady(hostPort: number): Promise<boolean> {
  return sharedProbe.isReady(hostPort);
}
