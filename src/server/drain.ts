import { llamaUpstreamBase } from "./llamaProxy";
import { countProcessingSlots, type FetchLike } from "./metrics/health";

/**
 * 排空（drain）判定：停止/切换模型容器前，等待在途推理结束，避免正在输出
 * 的 SSE 流被当场打断（llamapad-dsh-plugin 反馈）。纯逻辑 + 依赖注入，
 * 不直接依赖真实网络/定时器——fetch / now / sleep 均可注入供测试用。
 *
 * 关键取舍：/slots 探测不到（连接失败 / 非 200 / body 非数组 / JSON 坏）一律
 * 视为"探测不到忙碌就按不忙处理"，立刻放行（reason: "unavailable"），绝不
 * 重试等待——一个连不上的上游不能把模型切换永久卡死。
 *
 * slot 忙碌口径复用 metrics/health.ts 的 countProcessingSlots，不另起一份。
 *
 * 刻意不提供外部取消信号：排空跑在 POST /start 的请求处理内，调用方 fetch
 * 超时断连不应该反过来中断排空——那等于"客户端一挂断就改为硬杀容器"，与本
 * 模块的存在意义相反。单次探测的 3s 超时是唯一的兜底，不允许被替换掉。
 */

/** 单次 /slots 请求超时（毫秒），与 health.ts 的 REQUEST_TIMEOUT_MS 同量级 */
const SLOTS_REQUEST_TIMEOUT_MS = 3_000;

/** waitForIdle 未显式指定 pollMs 时的默认轮询间隔（毫秒） */
const DEFAULT_POLL_MS = 500;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface DrainResult {
  drained: boolean;
  reason: "idle" | "timeout" | "unavailable";
}

export interface WaitForIdleOptions {
  /** 待探测的 llama-server 宿主机端口 */
  hostPort: number;
  /** 最长等待时长（毫秒），超过仍未空闲则判超时 */
  timeoutMs: number;
  /** 轮询间隔（毫秒），默认 500 */
  pollMs?: number;
  fetch?: FetchLike;
  /** 时钟注入（测试用），默认 Date.now */
  now?: () => number;
  /** 睡眠注入（测试用），默认真实 setTimeout */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 打一次 /slots，返回处理中 slot 数；探测不到（连接失败/非 200/非数组/坏 JSON）
 * 一律返回 null。waitForIdle 与 probeBusy 共用本函数。
 */
async function fetchProcessingSlots(base: string, fetchImpl: FetchLike): Promise<number | null> {
  let response: Response;
  try {
    response = await fetchImpl(`${base}/slots`, {
      signal: AbortSignal.timeout(SLOTS_REQUEST_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const json: unknown = await response.json().catch(() => null);
  return countProcessingSlots(json);
}

/**
 * 轮询 /slots 直到处理中 slot 数为 0，或超时 / 探测失败。
 *
 * - 首次探测即空闲 → 立即返回 {drained:true, reason:"idle"}，不先睡一轮再探
 * - 探测不到（见文件头取舍）→ 立即返回 {drained:true, reason:"unavailable"}
 * - 超过 timeoutMs 仍处理中 → {drained:false, reason:"timeout"}（调用方照停不误）
 */
export async function waitForIdle(options: WaitForIdleOptions): Promise<DrainResult> {
  const {
    hostPort,
    timeoutMs,
    pollMs = DEFAULT_POLL_MS,
    fetch: fetchImpl = fetch,
    now = Date.now,
    sleep = defaultSleep,
  } = options;

  const base = llamaUpstreamBase(hostPort);
  const deadline = now() + timeoutMs;

  for (;;) {
    const running = await fetchProcessingSlots(base, fetchImpl);
    if (running === null) return { drained: true, reason: "unavailable" };
    if (running === 0) return { drained: true, reason: "idle" };
    if (now() >= deadline) return { drained: false, reason: "timeout" };
    await sleep(pollMs);
  }
}

export interface ProbeBusyDeps {
  fetch?: FetchLike;
}

/**
 * 单次忙碌探测（不轮询）：正常返回 {inferring, slotsRunning}；任何异常 / 非
 * 200 / 非数组都返回 null——含义是"不可知"，不是"不忙"，调用方（如
 * GET /api/v1/runtime/status?busy=1）应把 null 与"确定空闲"区分展示。
 */
export async function probeBusy(
  hostPort: number,
  deps: ProbeBusyDeps = {},
): Promise<{ inferring: boolean; slotsRunning: number } | null> {
  const base = llamaUpstreamBase(hostPort);
  const fetchImpl = deps.fetch ?? fetch;
  const running = await fetchProcessingSlots(base, fetchImpl);
  if (running === null) return null;
  return { inferring: running > 0, slotsRunning: running };
}
