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
