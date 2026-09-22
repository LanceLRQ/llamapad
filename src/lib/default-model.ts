/**
 * 默认模型决议（多模型并行，决策 D5）
 *
 * 默认模型是 API 中转在请求不带 model 字段时的目标。它只存在于 runtime 服务的
 * 进程内状态里，不落库：它描述的是「现在谁在跑」这类运行期事实，与容器 label
 * 一样应当在面板重启后从真实状态重建，落库反而会和实际运行状态脱节。
 *
 * 「换一个」取最早启动的那个，而不是 docker 列表的第一项：docker API 的返回
 * 顺序不保证稳定，按它取会让默认模型在两次查询之间来回跳。
 */

interface Startable {
  container: string;
  startedAt: string | null;
}

function startedMs(item: Startable): number {
  if (item.startedAt === null) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(item.startedAt);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/** 按启动时间升序排（返回新数组）；时间相同或都拿不到时按容器名排，保证结果稳定 */
export function sortByStartedAt<T extends Startable>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    const ta = startedMs(a);
    const tb = startedMs(b);
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.container.localeCompare(b.container);
  });
}

/**
 * 决议当前默认模型：current 仍在运行则保持；否则取 running 的第一项；
 * running 为空返回 null。running 须已按 sortByStartedAt 排好序。
 */
export function resolveDefaultModel(
  current: string | null,
  running: readonly { model: string }[],
): string | null {
  if (current !== null && running.some((item) => item.model === current)) return current;
  return running[0]?.model ?? null;
}
