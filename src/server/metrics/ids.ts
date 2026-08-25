/**
 * 指标标识与采样单元（M3 Task 2）
 *
 * 三类采集器（dockerStats / health / nvidiaSmi）统一产出 Sample，
 * 由调度器（collector.ts）喂给 onSample 回调（T3 的 metrics store 消费）。
 * metric 用点分命名空间字符串，UI 侧按前缀分容器 / 推理 / GPU 三组图表。
 */

/** 全部指标 id（字面量锚定，防止采集器与 UI/store 各写一份字符串漂移） */
export const METRIC_IDS = {
  /** 容器 CPU 占用率（%，多核可超 100） */
  containerCpuPercent: "container.cpu_percent",
  /** 容器内存用量（字节） */
  containerMemBytes: "container.mem_bytes",
  /** 容器内存占用率（%，mem/limit×100） */
  containerMemPercent: "container.mem_percent",
  /** 推理吞吐（tokens/秒，/metrics 计数器差分） */
  inferTokensPerSec: "infer.tokens_per_sec",
  /** KV cache 占用（tokens，/health slots[].cache_tokens 求和） */
  inferKvCacheTokens: "infer.kv_cache_tokens",
  /** 运行中的 slot 数（/health slots_running） */
  inferSlotsRunning: "infer.slots_running",
  /** GPU 显存占用（MiB，nvidia-smi memory.used） */
  gpuMemUsedMib: "gpu.mem_used_mib",
  /** GPU 利用率（%，nvidia-smi utilization.gpu） */
  gpuUtilPercent: "gpu.util_percent",
} as const;

/** 指标 id 类型（METRIC_IDS 的值联合） */
export type MetricId = (typeof METRIC_IDS)[keyof typeof METRIC_IDS];

/** 采样点：采集器产出、T3 metrics store 消费的最小单元 */
export interface Sample {
  metric: MetricId;
  value: number;
  /** 采样时间戳（毫秒） */
  ts: number;
}
