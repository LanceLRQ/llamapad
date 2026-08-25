import { METRIC_IDS, type Sample } from "./ids";
import { llamaUpstreamBase } from "@/server/llamaProxy";

/**
 * llama.cpp health/metrics 采集器（M3 Task 2）
 *
 * 对运行中容器的 llama-server（127.0.0.1:<host_port>）打两个端点：
 * - GET /health：JSON 宽容解析——slots_running（数值才有）→ infer.slots_running，
 *   slots[].cache_tokens 求和 → infer.kv_cache_tokens；字段缺失/类型不对/
 *   JSON 坏都不抛，跳过即可
 * - GET /metrics：prometheus 文本解析 llama_prompt_tokens_total 与
 *   llama_tokens_predicted_total 两个计数器，与上次值差分 → infer.tokens_per_sec
 *   （(Δprompt+Δpredicted)/Δt 秒，总吞吐口径）；首轮只建基线不产出；
 *   计数器回绕（重启后变小）重置基准不产出；404/非 200 静默
 *
 * 特性降级：两个端点任何连接失败/超时（AbortSignal.timeout 3s）→ 本轮无样本
 * ——容器可能正在启动/停止的间隙，静默等下一轮。
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

      // ---- /health：宽容解析，连接失败 → 整轮放弃（下轮再来） ----
      let health: Response;
      try {
        health = await fetchImpl(`${base}/health`, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        return [];
      }
      if (health.ok) {
        const json: unknown = await health.json().catch(() => null);
        if (json !== null && typeof json === "object") {
          const obj = json as Record<string, unknown>;

          const slotsRunning = obj.slots_running;
          if (typeof slotsRunning === "number" && Number.isFinite(slotsRunning)) {
            samples.push({ metric: METRIC_IDS.inferSlotsRunning, value: slotsRunning, ts: now });
          }

          if (Array.isArray(obj.slots)) {
            let cacheTokens = 0;
            let seen = false;
            for (const slot of obj.slots) {
              const value = (slot as Record<string, unknown> | null)?.cache_tokens;
              if (typeof value === "number" && Number.isFinite(value)) {
                cacheTokens += value;
                seen = true;
              }
            }
            if (seen) {
              samples.push({ metric: METRIC_IDS.inferKvCacheTokens, value: cacheTokens, ts: now });
            }
          }
        }
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
