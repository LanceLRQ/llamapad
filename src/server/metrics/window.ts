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
  /**
   * 全指标键集，含义随 mode 而变：
   * - mode:"full" 下空数组 = 该指标未采集（前端据此隐藏卡片，既有行为）
   * - mode:"delta" 下空数组 = 本轮无新点，绝不表示未采集
   */
  series: { [metric: string]: WindowPoint[] };
  /** 增量协议判别字段：降源判定完全留在服务端，客户端只认这个字段 */
  mode: "full" | "delta";
}

/** 解析 range 查询参数：仅接受四个字面量档位，其余（含缺失）null → 400 */
export function parseRangeKey(raw: string | null): RangeKey | null {
  return raw !== null && (RANGE_KEYS as readonly string[]).includes(raw) ? (raw as RangeKey) : null;
}

/** queryRange 结果整形为响应体：补全空键 + 标注 range/from/resolution/mode */
export function buildWindowPayload(
  range: RangeKey,
  from: number,
  queried: { [metric: string]: WindowPoint[] },
  mode: "full" | "delta",
): WindowPayload {
  const series: { [metric: string]: WindowPoint[] } = {};
  for (const id of Object.values(METRIC_IDS)) {
    series[id] = queried[id] ?? [];
  }
  return { range, from, resolution: resolutionForRange(range), series, mode };
}

/** planWindowQuery 的判定结果：route 层照此组装 store 查询与响应 */
export interface WindowQueryPlan {
  mode: "full" | "delta";
  /** 交给 store.queryRange 的起点 */
  queryFrom: number;
  /** delta 的水位：严格大于它的点才返回；full 时为 null */
  since: number | null;
}

/**
 * 增量查询降源判定（指标窗口增量协议，方案 A）：三条否决任一成立就忽略
 * since、退化为 full——客户端不做任何自己的判断，只认服务端回的 mode。
 *
 * @param range 当前窗口档位
 * @param sinceRaw 客户端持有的最新点 ts（查询参数原始字符串，未校验）
 * @param from 窗口起点 = now - RANGE_DEFS[range]
 */
export function planWindowQuery(range: RangeKey, sinceRaw: string | null, from: number): WindowQueryPlan {
  const full: WindowQueryPlan = { mode: "full", queryFrom: from, since: null };

  // 否决①：sinceRaw 缺失/空串/非数字。Number("") 是 0 而非 NaN，空串必须
  // 单独挡掉，否则会被当成"客户端持有 ts=0 的点"误判为合法 since。
  // 覆盖首次加载、切档这两种正常情况。
  if (sinceRaw === null || sinceRaw === "") return full;
  const since = Number(sinceRaw);
  if (!Number.isFinite(since)) return full;

  // 否决②：24h/7d 背后是 15min 聚合桶，store.ts 的 rollup15AndPurge 里
  // 写着"迟到落盘的 1min 桶能在下一轮 rollup 自愈进对应 15min 桶"——已经
  // 发出去的点，它的值还可能变；增量追加会把旧值永久钉死在客户端。而且
  // 这两档轮询恒 60s，是冷路径，不值得为这点收益引入正确性坑。
  if (resolutionForRange(range) !== "5s") return full;

  // 否决③：since < from——客户端持有的最新点已滑出窗口（标签页睡很久后
  // 回来），它手上整份数据都过期了，必须整体替换而非追加。
  if (since < from) return full;

  return { mode: "delta", queryFrom: since, since };
}
