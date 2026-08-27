import { METRIC_IDS, type Sample } from "./ids";
import { llamaUpstreamBase } from "@/server/llamaProxy";

/**
 * llama.cpp health 采集器（M3 Task 2，M4 真机订正，M5 口径订正 + /metrics 移除）
 *
 * 对运行中容器的 llama-server（127.0.0.1:<host_port>）打两个端点：
 * - GET /health：仅作存活探测。真机 body 恒为 {"status":"ok"}，不含任何
 *   slot 信息（M3 阶段曾猜测 body 里有 slots_running/slots[].cache_tokens，
 *   真机验证后确认无此字段，相关解析代码已删除）——连接失败或非 200 都视为
 *   本轮不可用，直接放弃整轮（下轮再来）。
 * - GET /slots：slot 信息的真实来源，返回 slot 数组。数组中 is_processing
 *   ===true 的个数 → infer.slots_running；处理中 slot 的 n_prompt_tokens
 *   与 next_token（真机有数组包一个对象、和裸对象两种形态，均兼容）里的
 *   n_decoded 相加，跨 slot 求和 → infer.kv_cache_tokens。哪怕全部空闲，
 *   只要拿到合法数组就照常产出 0（0 是有意义的读数）。同一 slot（同 id 且
 *   同 id_task）跨 tick 的 next_token.n_decoded 差分 → infer.tokens_per_sec，
 *   口径是纯生成速率（不含 prompt eval），与 llama.cpp 日志里每个 slot 的
 *   tg 同量纲。非 200（如 --no-slots 场景下的 501）/ body 非数组 / JSON 坏 /
 *   连接失败，都只静默跳过这三个指标，不影响 /health 的采集。
 *
 * GET /metrics 已不再请求（M5 删除）：原先解析 llama_prompt_tokens_total
 * 与 llama_tokens_predicted_total 差分算 tokens_per_sec 的逻辑存在两个问题
 * ——该计数器在请求完成时才结算，单请求场景整个生成期无新点，结束那个 5s
 * 窗口一次性差出尖峰（锯齿）；且口径是 (Δprompt+Δpredicted)/Δt 含 prompt
 * eval，与面板「生成吞吐」名实不符（M4 压测实测面板 412.8 t/s，日志各
 * slot tg 合计约 108 t/s）。tokens_per_sec 改用 /slots 的 n_decoded 差分后，
 * /metrics 请求不再被任何指标消费，成为纯空跑往返，故移除（llama-server
 * 侧仍带 --metrics 参数暴露该端点，可直连诊断用）。
 *
 * 特性降级：/health 连接失败/非 200/超时（AbortSignal.timeout 3s）→ 整轮
 * 放弃，容器可能正在启动/停止的间隙，静默等下一轮——它是本轮唯一的存活
 * 闸门；/slots 独立降级，连接失败只静默跳过自己的指标。
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

/** 取有限数值字段：缺失 / 类型不对 / NaN 一律按 0，不影响其他 slot 的求和 */
function finiteOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** 单个处理中 slot 的生成进度快照（跨 tick 差分算生成速率用） */
interface SlotProgress {
  id: number;
  idTask: number;
  nDecoded: number;
}

/** /slots 解析结果：两个即时指标 + 供差分的 per-slot 明细 */
interface SlotSnapshot {
  running: number;
  kvTokens: number;
  progress: SlotProgress[];
}

/**
 * 统计 /slots 返回数组中 is_processing===true 的个数（正在处理请求的 slot 数）。
 * 非数组入参返回 null——用于区分"探测失败/形态不对"与"合法数组但全部空闲(0)"，
 * 调用方（parseSlots、drain.ts 的排空判定）据此判断这是不可知还是确定空闲。
 * 这是 slot 忙碌口径的唯一来源，parseSlots 与 drain.ts 都改用它，不各写一份。
 */
export function countProcessingSlots(json: unknown): number | null {
  if (!Array.isArray(json)) return null;
  let running = 0;
  for (const item of json) {
    const slot = item as Record<string, unknown> | null;
    if (slot && slot.is_processing === true) running += 1;
  }
  return running;
}

/**
 * 解析 /slots 返回的 slot 数组：is_processing===true 的个数为运行中 slot 数
 * （countProcessingSlots）；处理中 slot 的 n_prompt_tokens + next_token.n_decoded
 * 跨 slot 求和为 KV 占用。next_token 真机有数组包一个对象、和裸对象两种形态，
 * 都兼容；字段缺失/非有限数按 0 计入该项，不影响其他 slot。非数组入参返回
 * null——调用方据此判断是否产出这两个指标（空闲时全 0 也算合法数组，要产出）。
 *
 * progress 只收 id / id_task / next_token.n_decoded 三个字段都真实存在的
 * slot——缺席不等于 0，这是防止 slot 转 idle 那一 tick（此时 next_token
 * 整个消失）在差分路径上被当成"decoded 骤降到 0"、算出巨大负值的关键。
 */
function parseSlots(json: unknown): SlotSnapshot | null {
  const running = countProcessingSlots(json);
  if (running === null || !Array.isArray(json)) return null;
  let kvTokens = 0;
  const progress: SlotProgress[] = [];
  for (const item of json) {
    const slot = item as Record<string, unknown> | null;
    if (!slot || slot.is_processing !== true) continue;

    const nextTokenRaw = slot.next_token;
    const nextToken = (Array.isArray(nextTokenRaw) ? nextTokenRaw[0] : nextTokenRaw) as
      | Record<string, unknown>
      | undefined
      | null;

    kvTokens += finiteOrZero(slot.n_prompt_tokens) + finiteOrZero(nextToken?.n_decoded);

    const id = slot.id;
    const idTask = slot.id_task;
    const nDecoded = nextToken?.n_decoded;
    if (
      typeof id === "number" && Number.isFinite(id) &&
      typeof idTask === "number" && Number.isFinite(idTask) &&
      typeof nDecoded === "number" && Number.isFinite(nDecoded)
    ) {
      progress.push({ id, idTask, nDecoded });
    }
  }
  return { running, kvTokens, progress };
}

export function createHealthCollector(
  getTarget: () => Promise<{ hostPort: number } | null>,
  deps: HealthCollectorDeps = {},
): HealthCollector {
  const fetchImpl: FetchLike = deps.fetch ?? fetch;

  /** 上一轮各 slot 的生成进度（key = slot id）；id_task 变化视为换了请求，重建基线 */
  let lastProgress = new Map<number, { idTask: number; nDecoded: number; ts: number }>();

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

      // ---- /slots：slot 级信息，独立降级，不影响已产出的样本 ----
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

            // 生成速率：同一 slot 且同一 id_task 才差分——换请求 / 首次见到只建基线。
            // 口径是「已解码 token 数的增量」，不含 prompt eval，与 llama.cpp 日志的 tg 同量纲
            const nextProgress = new Map<number, { idTask: number; nDecoded: number; ts: number }>();
            let decodedDelta = 0;
            let dtSeconds = 0;
            for (const p of parsed.progress) {
              nextProgress.set(p.id, { idTask: p.idTask, nDecoded: p.nDecoded, ts: now });
              const prev = lastProgress.get(p.id);
              if (prev === undefined || prev.idTask !== p.idTask) continue; // 新请求，只建基线
              const delta = p.nDecoded - prev.nDecoded;
              const dt = (now - prev.ts) / 1_000;
              if (delta > 0 && dt > 0) {
                decodedDelta += delta;
                // 同轮各 slot 的 dt 相同：nextProgress 每轮都用同一个 now 从
                // parsed.progress 整体重建，凡是能参与本轮差分的 slot，其
                // prev.ts 必然等于上一轮的 now，取其一即可
                dtSeconds = Math.max(dtSeconds, dt);
              }
            }
            lastProgress = nextProgress;
            if (decodedDelta > 0 && dtSeconds > 0) {
              samples.push({
                metric: METRIC_IDS.inferTokensPerSec,
                value: decodedDelta / dtSeconds,
                ts: now,
              });
            }
          }
        }
      } catch {
        // 连接失败：静默跳过这三个指标，不中断整轮
      }

      return samples;
    },
  };
}
