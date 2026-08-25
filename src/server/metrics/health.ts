import { METRIC_IDS, type Sample } from "./ids";
import { llamaUpstreamBase } from "@/server/llamaProxy";

/**
 * llama.cpp health/metrics 采集器（M3 Task 2，M4 真机订正）
 *
 * 对运行中容器的 llama-server（127.0.0.1:<host_port>）打三个端点：
 * - GET /health：仅作存活探测。真机 body 恒为 {"status":"ok"}，不含任何
 *   slot 信息（M3 阶段曾猜测 body 里有 slots_running/slots[].cache_tokens，
 *   真机验证后确认无此字段，相关解析代码已删除）——连接失败或非 200 都视为
 *   本轮不可用，直接放弃整轮（下轮再来）。
 * - GET /slots：slot 信息的真实来源，返回 slot 数组。数组中 is_processing
 *   ===true 的个数 → infer.slots_running；处理中 slot 的 n_prompt_tokens
 *   与 next_token（真机有数组包一个对象、和裸对象两种形态，均兼容）里的
 *   n_decoded 相加，跨 slot 求和 → infer.kv_cache_tokens。哪怕全部空闲，
 *   只要拿到合法数组就照常产出 0（0 是有意义的读数）。非 200（如
 *   --no-slots 场景下的 501）/ body 非数组 / JSON 坏 / 连接失败，都只
 *   静默跳过这两个指标，不影响 /health、/metrics 的采集。
 * - GET /metrics：prometheus 文本解析 llama_prompt_tokens_total 与
 *   llama_tokens_predicted_total 两个计数器，与上次值差分 → infer.tokens_per_sec
 *   （(Δprompt+Δpredicted)/Δt 秒，总吞吐口径）；首轮只建基线不产出；
 *   计数器回绕（重启后变小）重置基准不产出；404/非 200 静默
 *
 * 特性降级：/health 连接失败/非 200/超时（AbortSignal.timeout 3s）→ 整轮
 * 放弃，容器可能正在启动/停止的间隙，静默等下一轮；/slots、/metrics 各自
 * 独立降级，互不牵连。
 */

/** 单端点超时（毫秒）：容器本机回环，3s 足够宽裕 */
const REQUEST_TIMEOUT_MS = 3_000;

/** fetch 注入形态（测试 mock 用；缺省全局 fetch） */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface HealthCollectorDeps {
  fetch?: FetchLike;
}

export interface HealthCollector {
  tick(): Promise<Sample[]>;
}

/** /metrics 文本里要差分的两个计数器（llama.cpp 内建 prometheus 指标） */
interface TokenCounters {
  prompt: number;
  predicted: number;
}

/**
 * 解析 prometheus 文本中的两个 token 计数器（行格式 "name value"）。
 * 只认裸计数器行（# 开头的 HELP/TYPE 跳过）；两行都在才返回，否则 null
 * —— llama.cpp 的 /metrics 有则成对出现，缺任一按"该版本无此特性"静默。
 */
function parseTokenCounters(text: string): TokenCounters | null {
  let prompt: number | undefined;
  let predicted: number | undefined;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const [name, rawValue, ...rest] = line.split(/\s+/);
    if (rest.length > 0 || rawValue === undefined) continue; // "name value" 恰两列
    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;
    // 指标名带 llamacpp: 前缀（M4 真机实测；M3 误记为 llama_ 无前缀形式）
    if (name === "llamacpp:prompt_tokens_total") prompt = value;
    else if (name === "llamacpp:tokens_predicted_total") predicted = value;
  }
  if (prompt === undefined || predicted === undefined) return null;
  return { prompt, predicted };
}

/** 取有限数值字段：缺失 / 类型不对 / NaN 一律按 0，不影响其他 slot 的求和 */
function finiteOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** /slots 求和结果：运行中 slot 数 + KV 占用 tokens */
interface SlotAccumulator {
  running: number;
  kvTokens: number;
}

/**
 * 解析 /slots 返回的 slot 数组：is_processing===true 的个数为运行中 slot 数；
 * 处理中 slot 的 n_prompt_tokens + next_token.n_decoded 跨 slot 求和为 KV 占用。
 * next_token 真机有数组包一个对象、和裸对象两种形态，都兼容；字段缺失/非
 * 有限数按 0 计入该项，不影响其他 slot。非数组入参返回 null——调用方据此
 * 判断是否产出这两个指标（空闲时全 0 也算合法数组，要产出）。
 */
function parseSlots(json: unknown): SlotAccumulator | null {
  if (!Array.isArray(json)) return null;
  let running = 0;
  let kvTokens = 0;
  for (const item of json) {
    const slot = item as Record<string, unknown> | null;
    if (!slot || slot.is_processing !== true) continue;
    running += 1;

    const nextTokenRaw = slot.next_token;
    const nextToken = (Array.isArray(nextTokenRaw) ? nextTokenRaw[0] : nextTokenRaw) as
      | Record<string, unknown>
      | undefined
      | null;

    kvTokens += finiteOrZero(slot.n_prompt_tokens) + finiteOrZero(nextToken?.n_decoded);
  }
  return { running, kvTokens };
}

export function createHealthCollector(
  getTarget: () => Promise<{ hostPort: number } | null>,
  deps: HealthCollectorDeps = {},
): HealthCollector {
  const fetchImpl: FetchLike = deps.fetch ?? fetch;

  /** 上一轮的计数器基线；回绕（值变小）时重置 */
  let last: { ts: number } & TokenCounters | null = null;

  return {
    async tick(): Promise<Sample[]> {
      const target = await getTarget();
      if (target === null) return [];

      const base = llamaUpstreamBase(target.hostPort);
      const now = Date.now();
      const samples: Sample[] = [];

      // ---- /health：存活探测。真机 body 仅 {"status":"ok"}，不解析 body；
      // 连接失败或非 200 都放弃整轮（下轮再来） ----
      let health: Response;
      try {
        health = await fetchImpl(`${base}/health`, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        return [];
      }
      if (!health.ok) return [];

      // ---- /slots：slot 级信息，独立降级，不影响 /metrics ----
      try {
        const slots = await fetchImpl(`${base}/slots`, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (slots.ok) {
          const json: unknown = await slots.json().catch(() => null);
          const parsed = parseSlots(json);
          if (parsed !== null) {
            samples.push({ metric: METRIC_IDS.inferSlotsRunning, value: parsed.running, ts: now });
            samples.push({ metric: METRIC_IDS.inferKvCacheTokens, value: parsed.kvTokens, ts: now });
          }
        }
      } catch {
        // 连接失败：静默跳过这两个指标，不中断整轮（/metrics 仍要采）
      }

      // ---- /metrics：计数器差分 → tokens/s；404/非 200 静默 ----
      let metrics: Response;
      try {
        metrics = await fetchImpl(`${base}/metrics`, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        return [];
      }
      if (metrics.ok) {
        const counters = parseTokenCounters(await metrics.text());
        if (counters !== null) {
          const wrap = last !== null && (counters.prompt < last.prompt || counters.predicted < last.predicted);
          if (last !== null && !wrap) {
            const dtSeconds = (now - last.ts) / 1_000;
            const delta = counters.prompt - last.prompt + (counters.predicted - last.predicted);
            if (dtSeconds > 0 && delta > 0) {
              samples.push({ metric: METRIC_IDS.inferTokensPerSec, value: delta / dtSeconds, ts: now });
            }
          }
          // 基线总是推进到本轮（首轮建立 / 回绕重置都落在这里）
          last = { ts: now, prompt: counters.prompt, predicted: counters.predicted };
        }
      }

      return samples;
    },
  };
}
