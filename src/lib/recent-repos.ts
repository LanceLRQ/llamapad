/**
 * 首页「最近更新的仓库」的排序与截断（2026-09-21 设计 §3.3）。
 *
 * 泛型只约束用到的两个字段，不绑死 RepoProfileStats——本文件是纯逻辑层，
 * 不该为了排序而 import server 侧类型。
 */
export const RECENT_REPOS_LIMIT = 5;

export function pickRecentRepos<T extends { id: number; lastModified: number }>(
  profiles: readonly T[],
  limit: number = RECENT_REPOS_LIMIT,
): T[] {
  // 并列时按 id 倒序兜底：同一批下载落盘的档案 mtime 可能一模一样，
  // 不给第二判据的话顺序取决于入参顺序，看起来就像随机跳动
  return [...profiles].sort((a, b) => b.lastModified - a.lastModified || b.id - a.id).slice(0, limit);
}
