/**
 * 下载剩余时间估算（UX P0 Task 10 / U5）：纯函数，供下载页当前任务卡
 * 与顶栏徽标共用。速度来自客户端相邻快照差分（downloads-view），ETA =
 * 剩余字节 / 速度；速度不可得（暂停/启动瞬间/未知大小）返回 null 不展示。
 */

/** 剩余字节与速度 → 秒；无速度或已完成为 null */
export function estimateEtaSeconds(remainingBytes: number, bytesPerSec: number): number | null {
  if (remainingBytes <= 0 || bytesPerSec <= 0) return null;
  return remainingBytes / bytesPerSec;
}

/** 紧凑时长（locale 中立，数字+单位）：59s / 12m 30s / 1h 05m / 3h */
export function formatEta(seconds: number): string {
  const total = Math.max(1, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) {
    const sec = total % 60;
    return sec > 0 ? `${minutes}m ${String(sec).padStart(2, "0")}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const min = minutes % 60;
  return min > 0 ? `${hours}h ${String(min).padStart(2, "0")}m` : `${hours}h`;
}
