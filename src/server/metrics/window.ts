import { METRIC_IDS } from "./ids";

/**
 * 指标窗口查询的纯函数层（M3 Task 4）：GET /api/v1/metrics/window 的
 * range 解析与响应整形收敛在此（route 只是鉴权 + 组装的薄壳，模式对齐
 * logsStream.ts）。前端图表组件以空数组判定"未采集"→隐藏卡片，
 * 因此响应里 series 必须给全 METRIC_IDS 键集（缺者为空数组）。
 */

/** 可选时间窗（与概览图表 Tabs 一一对应） */
export const RANGE_KEYS = ["30m", "2h", "24h", "7d"] as const;

export type RangeKey = (typeof RANGE_KEYS)[number];

/** 各窗口时长（毫秒）：from = now - RANGE_DEFS[range] */
export const RANGE_DEFS: Record<RangeKey, number> = {
  "30m": 30 * 60_000,
  "2h": 2 * 3_600_000,
  "24h": 24 * 3_600_000,
  "7d": 7 * 24 * 3_600_000,
};

/**
 * 窗口分辨率标称值：≤2h 由内存 ring 覆盖（5s 采样）；
 * 更长窗口走 15min 聚合桶（store.queryRange 自动降源）。
 * 简化为按 range 档位报——混拼边界（如 2h 窗口 ring 只有 90 分钟 +
 * 前段桶点）标称仍 5s，图表侧不做区分。
 */
export function resolutionForRange(range: RangeKey): "5s" | "15m" {
  return range === "30m" || range === "2h" ? "5s" : "15m";
}

/** 窗口查询序列点（与 store.queryRange 的点结构一致） */
export interface WindowPoint {
  ts: number;
  value: number;
}

/** 窗口查询响应体 */
export interface WindowPayload {
  range: RangeKey;
  /** 窗口起点（毫秒时间戳） */
  from: number;
  resolution: "5s" | "15m";
  /** 全指标键集：未采集者为空数组 */
  series: { [metric: string]: WindowPoint[] };
}

/** 解析 range 查询参数：仅接受四个字面量档位，其余（含缺失）null → 400 */
export function parseRangeKey(raw: string | null): RangeKey | null {
  return raw !== null && (RANGE_KEYS as readonly string[]).includes(raw) ? (raw as RangeKey) : null;
}

/** queryRange 结果整形为响应体：补全空键 + 标注 range/from/resolution */
export function buildWindowPayload(
  range: RangeKey,
  from: number,
  queried: { [metric: string]: WindowPoint[] },
): WindowPayload {
  const series: { [metric: string]: WindowPoint[] } = {};
  for (const id of Object.values(METRIC_IDS)) {
    series[id] = queried[id] ?? [];
  }
  return { range, from, resolution: resolutionForRange(range), series };
}
