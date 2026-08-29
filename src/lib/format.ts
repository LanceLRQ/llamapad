/**
 * 展示格式化小工具（server / client 通用，无依赖纯函数）。
 * M1 Task 9 从 models-table.tsx 提出共享：概览页磁盘卡同样需要人类可读大小。
 */

/** 人类可读大小：≥1 GiB 用 GB（一位小数，≥100 取整），≥1 MiB 用 MB，否则 KB；无效值 "—" */
export function formatSize(bytes: number): string {
  if (bytes <= 0) return "—";
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${gib >= 100 ? Math.round(gib) : gib.toFixed(1)} GB`;
  const mib = bytes / 1024 ** 2;
  if (mib >= 1) return `${mib.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * 占盘 GB 数值（M16 T5 从 models/page.tsx 提出共享，T6 files/page.tsx 同款
 * 复用）：与 formatSize 同一套精度换算（<100GB 保留 1 位小数，否则取整），
 * 只是这里不像 formatSize 那样按量级切 MB/KB——顶栏这一枚统计固定用 GB
 * 单位，小到 0 时交给 formatStat 判空态，这里不用管。
 */
export function toGigabytes(bytes: number): number {
  const gib = bytes / 1024 ** 3;
  return gib >= 100 ? Math.round(gib) : Math.round(gib * 10) / 10;
}
