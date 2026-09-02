/**
 * 缓存新鲜度判定（远端仓库清单缓存 / README 缓存共用）
 *
 * TTL 环境变量刻意用小时后缀（`PANEL_REPO_CACHE_TTL_HOURS`），不跟仓库既有的
 * 毫秒后缀先例（如 `PANEL_SHUTDOWN_GRACE_MS`）——本值的自然量级是「天」，
 * 写成毫秒（如 86400000）反人类，容易被后人当成笔误改错。这是刻意的偏离，
 * 不是疏漏。
 */

/** 仓库信息缓存的默认存活时长（小时） */
export const DEFAULT_CACHE_TTL_HOURS = 24;

const HOUR_MS = 3_600_000;

/**
 * 解析 TTL 环境变量 → 毫秒。
 * @param raw process.env.PANEL_REPO_CACHE_TTL_HOURS 的原值
 * @returns 毫秒；`0` 表示永不自动过期（返回 Number.POSITIVE_INFINITY）
 *
 * 负数 / 非数字 / 空串一律回落默认值，**不抛异常**——一个写错的环境变量
 * 不该让整个面板起不来。
 */
export function resolveTtlMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_CACHE_TTL_HOURS * HOUR_MS;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 0) return DEFAULT_CACHE_TTL_HOURS * HOUR_MS;
  if (hours === 0) return Number.POSITIVE_INFINITY;
  return hours * HOUR_MS;
}

/** 缓存是否已过期。fetchedAt 为 0 或负数（从未取过）一律算过期 */
export function isStale(fetchedAt: number, now: number, ttlMs: number): boolean {
  if (fetchedAt <= 0) return true;
  if (ttlMs === Number.POSITIVE_INFINITY) return false;
  return now - fetchedAt > ttlMs;
}
