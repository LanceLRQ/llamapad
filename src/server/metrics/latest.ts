import { METRIC_IDS, type MetricId } from "./ids";
import type { GpuDevice, NvidiaStatus } from "./nvidiaSmi";

/**
 * 当前值快照的纯函数层（M3 Task 5；G4 补 host/stats）：GET
 * /api/v1/{container,gpu,host}/stats 的样本挑选与响应整形收敛在此
 * （route 只做鉴权 + 组装的薄壳，模式对齐 window.ts）。监控页指标卡的
 * "当前值大数字"消费这三个接口。
 *
 * 语义：从 store.queryRange(now - 60s) 的结果里取各指标最后一个点——
 * queryRange 恒升序返回，"最近值" 即末点；函数内仍按 ts 取 max 做防御，
 * 不依赖调用方维持有序。
 *
 * 分母字段（T3；G4 追加宿主机三项）：GPU 分卡明细/显存合计（devices/
 * totals）、CPU 核数（cpuCount）、宿主机 CPU 核数/内存总量/磁盘总量
 * （hostCpuCount/hostMemTotalBytes/hostDiskTotalBytes）都不是时序指标，
 * 是"这次运行内的常量"，只挂在响应元信息里供前端拼 "6.1 / 24.0 GiB"、
 * "1247% (16 核)" 这类分数展示，不进 queryRange 覆盖的样本键集。
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

/** host/stats 的样本键集：hostStats 采集器九指标（G4：宿主机视角补充；
 *  任务 12 追加磁盘 IO 两项）——漏掉新指标不会报错，只是 /api/v1/host/stats
 *  永远不返回它，图表卡悄无声息地拿不到当前值，所以新增指标必须回填这里 */
export const HOST_STAT_METRICS: readonly MetricId[] = [
  METRIC_IDS.hostCpuPercent,
  METRIC_IDS.hostMemUsedBytes,
  METRIC_IDS.hostMemPercent,
  METRIC_IDS.hostLoad1,
  METRIC_IDS.hostDiskFreeBytes,
  METRIC_IDS.hostNetRxBytesPerSec,
  METRIC_IDS.hostNetTxBytesPerSec,
  METRIC_IDS.hostDiskReadBytesPerSec,
  METRIC_IDS.hostDiskWriteBytesPerSec,
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
  /** CPU 核数（分母）；未采集到 → null */
  cpuCount: number | null;
}

/** 当前值响应体（gpu/stats；status 非 available 时 samples 为 null，
 * available 字段是对外 HTTP 契约保留的旧字段，值由 status 派生） */
export interface GpuStatsPayload {
  available: boolean;
  status: NvidiaStatus;
  samples: { [metric: string]: LatestSample } | null;
  /** 分卡明细；非 available 时 [] */
  devices: GpuDevice[];
  /** 显存合计；devices 为空时 null */
  totals: { memUsedMib: number; memTotalMib: number } | null;
}

/** host/stats 的响应体：samples 键集不出的键即"未采集"（前端显示 —）；
 * 三个分母同 cpuCount 语义——一次运行内的常量，不进时序，尚未采到 → null */
export interface HostStatsPayload {
  samples: { [metric: string]: LatestSample };
  /** 宿主机 CPU 核数（host.cpu_percent 的分母） */
  hostCpuCount: number | null;
  /** 宿主机内存总量字节（host.mem_used_bytes 的分母） */
  hostMemTotalBytes: number | null;
  /** models 根所在分区总容量字节（host.disk_free_bytes 的分母） */
  hostDiskTotalBytes: number | null;
}

/**
 * 秒级快照覆盖合并（唯一的新算法，秒级指标采集 代号 B）：ring 取出的样本
 * （pickLatestSamples 的结果）与秒级快照按 ts 取新者，只覆盖 ids 列出的
 * 指标——fast 里混进的其他指标（如容器快照混进 GPU 路由）不会被带出去，
 * 两个响应各自只看自己的键集，互不串味。
 * fast 缺该指标 → 保留 ring 的值（或不出键，若 ring 也没有）；
 * ring 缺、fast 有 → 直接采用 fast；两者都有 → 取 ts 较新的一侧。
 */
export function overlayLatestSamples(
  ring: { [metric: string]: LatestSample },
  fast: { [metric: string]: LatestSample },
  ids: readonly MetricId[],
): { [metric: string]: LatestSample } {
  const merged: { [metric: string]: LatestSample } = { ...ring };
  for (const id of ids) {
    const fastSample = fast[id];
    if (fastSample === undefined) continue;
    const ringSample = merged[id];
    if (ringSample === undefined || fastSample.ts >= ringSample.ts) merged[id] = fastSample;
  }
  return merged;
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

/**
 * 分卡明细 → 显存合计（纯函数）：空数组返回 null——没有卡就没有
 * "总容量"这个概念，避免前端把 0/0 误当合法分母展示成 "0.0 / 0.0 GiB"。
 */
export function sumGpuTotals(
  devices: readonly GpuDevice[],
): { memUsedMib: number; memTotalMib: number } | null {
  if (devices.length === 0) return null;
  let memUsedMib = 0;
  let memTotalMib = 0;
  for (const device of devices) {
    memUsedMib += device.memUsedMib;
    memTotalMib += device.memTotalMib;
  }
  return { memUsedMib, memTotalMib };
}
