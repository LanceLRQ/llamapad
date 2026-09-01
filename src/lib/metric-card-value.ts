import { formatSize } from "./format";

/**
 * 概览合卡卡头「大数字 + 分母副标」的格式化纯逻辑（任务 13 从
 * monitoring/metric-cards.tsx 提纯）：vitest 是 environment: node 没有
 * jsdom，组件测不了，这些取整/拼装规则必须落在这里配单测，合卡改造才
 * 守得住数值不算错。
 */

/** 卡片展示值：文本 + 单位（单位随量级换算，见各格式化器） */
export interface CardValue {
  value: string;
  unit: string;
}

/** 百分比：≥100 取整，否则一位小数 */
export function formatPercent(v: number): CardValue {
  return { value: v >= 100 ? String(Math.round(v)) : v.toFixed(1), unit: "%" };
}

/** 百分比转纯文本（副标行拼接用，不需要 value/unit 分离展示） */
export function percentText(v: number): string {
  const p = formatPercent(v);
  return `${p.value}${p.unit}`;
}

/** GPU 显存 used/total 的 GiB 数值：固定按 GiB 对齐两个数字的量纲
 * （显卡显存几乎不会落在 MiB 量级，不必像 formatMib 那样按量级切换单位） */
export function toGib(mib: number): string {
  return (mib / 1024).toFixed(1);
}

/** MiB 量级展示：<1GiB 用整数 MiB，≥1GiB 一位小数 GiB */
export function formatMib(mib: number): CardValue {
  return mib >= 1024
    ? { value: (mib / 1024).toFixed(1), unit: "GiB" }
    : { value: String(Math.round(mib)), unit: "MiB" };
}

/** tokens 紧凑展示：≥1M/≥1k 一位小数缩写，否则整数 */
export function formatTokensCompact(v: number): CardValue {
  if (v >= 1_000_000) return { value: `${(v / 1_000_000).toFixed(1)}M`, unit: "tok" };
  if (v >= 1_000) return { value: `${(v / 1_000).toFixed(1)}k`, unit: "tok" };
  return { value: String(Math.round(v)), unit: "tok" };
}

/** 字节/秒速率展示：复用 formatSize 换算量级（KB/MB/GB 三档），拼上 "/s"。
 * formatSize 对 <=0 返回 "—"（无量纲可拆），网络/磁盘 IO 速率的 0（空闲）
 * 更适合显示 "0.0 KB/s" 而非 "—"——那意味着"没测到"，不是"确实是 0" */
export function formatBytesPerSec(bytesPerSec: number): CardValue {
  if (bytesPerSec <= 0) return { value: "0.0", unit: "KB/s" };
  const [value, unit] = formatSize(bytesPerSec).split(" ");
  return { value: value ?? "0.0", unit: `${unit ?? "KB"}/s` };
}

/** CPU 核数分母：{count} 核 · 满载 {max}%（cardCpuSub 模板的两个插值，
 *  容器卡与宿主机卡共用同一条模板，见 metric-cards.tsx 原注释） */
export function cpuCoresSub(count: number): { count: number; max: number } {
  return { count, max: count * 100 };
}

/** GPU 显存 used/total 的大数字覆盖值（GiB 对齐两个数字） */
export function gpuMemMain(usedMib: number, totalMib: number): CardValue {
  return { value: `${toGib(usedMib)} / ${toGib(totalMib)}`, unit: "GiB" };
}

/** GPU 显存占用率文本（used/total，供拼进副标） */
export function gpuMemPercentText(usedMib: number, totalMib: number): string {
  return percentText((usedMib / totalMib) * 100);
}

/** 磁盘剩余卡「剩余 / 总量」读数：主数字数值沿用 formatMib 的既有换算规则
 * （≥1GiB 一位小数、否则整数 MiB），只把单位标签从 GiB/MiB 换成 GB/MB——
 * 两者本就是同一套二进制换算（bytes / 1024^n），改造前的 bug 是"标签不一致"
 * （大数字标 GiB、副标用 formatSize 标 GB），不是精度不对，所以这里只换
 * 标签字、不改数值算法，避免顺手动了用户没提的精度策略。分母（总量）部分
 * 直接用 formatSize（该函数本就标 GB，不需要改），与主数字单位拼在一起；
 * total 缺失（未采到 hostDiskTotalBytes）时退化为只显示剩余读数。 */
export function hostDiskMain(freeBytes: number, totalBytes: number | null): CardValue {
  const free = formatMib(freeBytes / 1024 / 1024);
  const freeUnit = free.unit === "GiB" ? "GB" : "MB";
  if (totalBytes === null) return { value: free.value, unit: freeUnit };
  return { value: free.value, unit: `${freeUnit} / ${formatSize(totalBytes)}` };
}

/** GPU 温度取各卡 max（最热的卡是瓶颈）；无样本 null（副标该段不拼） */
export function gpuMaxTempC(temps: readonly number[]): number | null {
  return temps.length > 0 ? Math.round(Math.max(...temps)) : null;
}

/** GPU 功耗取各卡 sum（供电视角）；无样本 null（副标该段不拼） */
export function gpuTotalPowerW(powers: readonly number[]): number | null {
  return powers.length > 0 ? Math.round(powers.reduce((sum, p) => sum + p, 0)) : null;
}
