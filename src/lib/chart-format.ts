import type { WindowPoint } from "@/server/metrics/window";

/**
 * 概览页图表纯函数层（拆图卡重构）：抽稀 / 双序列归并 / 轴与图例格式化，
 * 从 overview-charts.tsx 提出——src/app 下没有测试基础设施（vitest include
 * 只认 src 目录树下的 .test.ts 文件），纯函数一律搬来这里配单测。
 */

/** 单图渲染点数上限：超过即步进抽稀（保留末点，保证最新值在图上） */
export const MAX_RENDER_POINTS = 500;

/** 序列点归并容差：同一采集 tick 的两指标 ts 通常相等，容差兜底毫秒级漂移 */
export function toleranceFor(resolution: "5s" | "15m"): number {
  return resolution === "5s" ? 2_500 : 450_000;
}

/** 双线同轴行：a/b 按 ts 就近归并，缺失为 undefined——拆卡后仅"宿主机网络
 *  收发"这一张卡还需要它（rx/tx 单位相同、共用一根 Y 轴，其余卡都已收窄成
 *  单序列，直接拿 WindowPoint[] 当 recharts data 用即可，无需归并） */
export interface TwoLineRow {
  ts: number;
  a?: number;
  b?: number;
}

/** 两列各自升序的序列按 ts 就近归并（|Δ| ≤ tolerance 视为同一时刻） */
export function mergeSeries(
  primary: WindowPoint[],
  secondary: WindowPoint[],
  tolerance: number,
): TwoLineRow[] {
  const rows: TwoLineRow[] = [];
  let i = 0;
  let j = 0;
  while (i < primary.length || j < secondary.length) {
    const pTs = i < primary.length ? primary[i].ts : Number.POSITIVE_INFINITY;
    const sTs = j < secondary.length ? secondary[j].ts : Number.POSITIVE_INFINITY;
    const ts = Math.min(pTs, sTs);
    const row: TwoLineRow = { ts };
    if (pTs - ts <= tolerance) {
      row.a = primary[i].value;
      i += 1;
    }
    if (sTs - ts <= tolerance) {
      row.b = secondary[j].value;
      j += 1;
    }
    rows.push(row);
  }
  return rows;
}

/** 步进采样抽稀：每隔 stride 取一点并强制保留末点 */
export function downsample<T>(rows: T[]): T[] {
  if (rows.length <= MAX_RENDER_POINTS) return rows;
  const stride = Math.ceil(rows.length / MAX_RENDER_POINTS);
  const out = rows.filter((_, index) => index % stride === 0);
  const last = rows[rows.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/** 序列最新值（图例展示用；空序列 null） */
export function latestValue(points: WindowPoint[] | undefined): number | null {
  if (!points || points.length === 0) return null;
  return points[points.length - 1].value;
}

/** 百分比展示：≥100 取整，否则一位小数 */
export function formatPercent(value: number): string {
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)}%`;
}

/** MiB 轴刻度紧凑格式（6.1G / 512M） */
export function formatMibAxis(mib: number): string {
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)}G` : `${Math.round(mib)}M`;
}

/** 字节轴刻度紧凑格式：宿主机内存/磁盘/网络卡的序列是原始字节，不是 MiB，
 *  故单独写一版（先换算到 MiB 再套同一 G/M 分档）。
 *
 * 曾经误用 formatMibAxis 格式化字节序列，轴标签量级因此错了约一千倍
 * （276 MiB 显示成 282624.0G）——GPU 显存的序列本就是 MiB
 * （gpu.mem_used_mib），继续用 formatMibAxis 是对的，但任何原始字节序列
 * 必须走本函数，别改回去。 */
export function formatBytesAxis(bytes: number): string {
  return formatMibAxis(bytes / 1024 / 1024);
}
