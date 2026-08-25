import { METRIC_IDS, type MetricId } from "./ids";
import type { NvidiaStatus } from "./nvidiaSmi";

/**
 * 当前值快照的纯函数层（M3 Task 5）：GET /api/v1/{container,gpu}/stats 的
 * 样本挑选与响应整形收敛在此（route 只做鉴权 + 组装的薄壳，模式对齐
 * window.ts）。监控页指标卡的"当前值大数字"消费这两个接口。
 *
 * 语义：从 store.queryRange(now - 60s) 的结果里取各指标最后一个点——
 * queryRange 恒升序返回，"最近值" 即末点；函数内仍按 ts 取 max 做防御，
 * 不依赖调用方维持有序。
 */

/** 快照回看窗口（毫秒）：60s 足以跨过采集心跳抖动（5s 一轮），又不会把
 * 早已停止的容器旧值误当"当前值"展示太久 */
export const STATS_LOOKBACK_MS = 60_000;

/** container/stats 的样本键集：dockerStats + health 两组指标（UI 指标卡上区） */
export const CONTAINER_STAT_METRICS: readonly MetricId[] = [
  METRIC_IDS.containerCpuPercent,
  METRIC_IDS.containerMemBytes,
  METRIC_IDS.containerMemPercent,
  METRIC_IDS.inferTokensPerSec,
  METRIC_IDS.inferKvCacheTokens,
  METRIC_IDS.inferSlotsRunning,
];

/** gpu/stats 的样本键集：nvidiaSmi 两指标 */
export const GPU_STAT_METRICS: readonly MetricId[] = [
  METRIC_IDS.gpuMemUsedMib,
  METRIC_IDS.gpuUtilPercent,
];

/** 当前值样本点（stats 接口的值形态） */
export interface LatestSample {
  value: number;
  ts: number;
}

/** 当前值响应体（container/stats） */
export interface ContainerStatsPayload {
  samples: { [metric: string]: LatestSample };
  running: { model: string; displayName: string } | null;
}

/** 当前值响应体（gpu/stats；status 非 available 时 samples 为 null，
 * available 字段随 status 派生，供旧调用方兼容读取） */
export interface GpuStatsPayload {
  available: boolean;
  status: NvidiaStatus;
  samples: { [metric: string]: LatestSample } | null;
}

/**
 * 从 queryRange 结果挑选各指标最近点：窗口内无点的指标不出键
 * （前端以"键不存在"判该卡显示 —，与 window API 的"空数组"语义对齐）。
 */
export function pickLatestSamples(
  queried: { [metric: string]: { ts: number; value: number }[] },
  ids: readonly MetricId[],
): { samples: { [metric: string]: LatestSample } } {
  const samples: { [metric: string]: LatestSample } = {};
  for (const id of ids) {
    let latest: { ts: number; value: number } | null = null;
    for (const point of queried[id] ?? []) {
      if (latest === null || point.ts >= latest.ts) latest = point;
    }
    if (latest !== null) samples[id] = { value: latest.value, ts: latest.ts };
  }
  return { samples };
}
