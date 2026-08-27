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

/** 二进制量级单位表；索引 i 对应 1024^i 字节 */
const BINARY_UNITS = ["B", "K", "M", "G", "T", "P"] as const;

/**
 * 轴刻度的量级自适应：从 startIndex 档起按 1024 双向换算到最合适的单位。
 *
 * 双向是关键——只向上换算（原实现只有 M/G 两档）会让小量级全被压成同一个
 * 标签：真机网络卡实际值在 3–19 KB/s，五个刻度曾全部渲染成 "1M/s" 与
 * "0M/s"，读者看不出任何差别。
 *
 * 零不带单位：轴底显示 "0" 比 "0B" 干净，且不会误导读者以为该轴以字节为档。
 * 整数不留 ".0"：刻度标签要短，"3K" 优于 "3.0K"。
 */
function formatBinaryScaled(value: number, startIndex: number): string {
  if (!Number.isFinite(value)) return "";
  if (value === 0) return "0";
  const sign = value < 0 ? "-" : "";
  let scaled = Math.abs(value);
  let index = startIndex;
  while (scaled >= 1024 && index < BINARY_UNITS.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  while (scaled < 1 && index > 0) {
    scaled *= 1024;
    index -= 1;
  }
  // 十以下留一位小数（0.5G 与 0.9G 需要区分），十以上取整（刻度不需要那个精度）
  const text = scaled >= 10 ? String(Math.round(scaled)) : scaled.toFixed(1).replace(/\.0$/, "");
  return `${sign}${text}${BINARY_UNITS[index]}`;
}

/** MiB 序列的轴刻度（如 gpu.mem_used_mib）：入参单位是 MiB，故从 M 档起算 */
export function formatMibAxis(mib: number): string {
  return formatBinaryScaled(mib, BINARY_UNITS.indexOf("M"));
}

/**
 * 原始字节序列的轴刻度（宿主机内存/磁盘/网络等）：从 B 档起算。
 *
 * 曾经误用 formatMibAxis 格式化字节序列，轴标签量级因此错了约一千倍
 * （276 MiB 显示成 282624.0G）——两者的差别只在起算档位，别再混用。
 */
export function formatBytesAxis(bytes: number): string {
  return formatBinaryScaled(bytes, 0);
}
