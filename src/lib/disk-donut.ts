/**
 * 磁盘剩余卡环形图（donut）的纯计算层：已用/剩余两段字节数 + 中心展示的
 * 使用率百分比。vitest 是 environment: "node" 没有 jsdom，组件测不了，
 * 百分比取整与分段夹值规则必须落在这里配单测。
 *
 * 与 lib/metric-card-value.ts 的 hostDiskMain 分工：那边管卡头大数字读数
 * 的字符串拼装，这里管环形图要用的字节段与百分比——两者都吃同一对
 * （freeBytes, totalBytes）入参，但服务不同的展示目标（文本 vs 图形），
 * 不合并成一个函数。
 */

/** 环形图两段数据：已用/剩余字节数 + 取整后的使用率（中心文案用） */
export interface DiskDonutData {
  usedBytes: number;
  freeBytes: number;
  /** 使用率，四舍五入到整数（中心文案不需要小数） */
  percentUsed: number;
}

/**
 * total 缺失或非正数时返回 null——组件按 null 决定环形图整体不渲染（对应
 * "数据缺失时不渲染"的验收要求，判空只在这一处，组件不重复判断）。
 *
 * freeBytes 允许为 0：磁盘写满是合法状态，不是"没采到"——"没采到"已经在
 * 上一层由 samples[...] !== undefined 挡掉了，走到这里的 freeBytes 一定是
 * 一次真实采样。若因脏数据出现 freeBytes > totalBytes，已用段夹到 0，不
 * 展示负数扇区。
 */
export function computeDiskDonut(freeBytes: number, totalBytes: number | null): DiskDonutData | null {
  if (totalBytes === null || totalBytes <= 0) return null;
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  const percentUsed = Math.round((usedBytes / totalBytes) * 100);
  return { usedBytes, freeBytes, percentUsed };
}
