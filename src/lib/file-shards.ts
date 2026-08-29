import { shardGroup } from "@/core/files";

/**
 * 分片归组纯逻辑（M16 T6）：把 files-table.tsx 原来靠"相邻性"推分片组的
 * buildRows 拆出排序无关的一半——按 rel 排序时同组分片天然相邻，但用户按
 * 大小/修改时间排序后相邻关系被打散，分片徽标（"×N"）就跟着不准了。
 * 本模块只负责"这个文件属于哪组、组里一共几个文件"，与调用方以什么顺序
 * 遍历、按什么排序完全无关；渲染时的相邻高亮（first/last）仍由调用方按
 * 当前呈现顺序自己算，那部分是视觉层面的事，不属于"归组"这个判断本身。
 */

export interface ShardIndexEntry {
  /** 组键；非分片命名为 null（各自独立，不与任何文件同组） */
  key: string | null;
  /** 该组的实际文件数（非分片 = 1） */
  size: number;
}

/**
 * rel → 分片组归属。入参是该命名空间的全量文件（顺序无关，函数内部自己
 * 按组键归堆，不依赖入参顺序）。组键构造沿用 files-table.tsx 原 buildRows
 * 的做法：`${目录前缀}|${shardGroup(basename).prefix}|${shardGroup(basename).total}`
 * ——目录前缀入键是为了不让不同命名空间下同名分片串组，total 入键是为了
 * 不让声明的分片总数不同的文件被误判成同一组。
 */
export function buildShardIndex(files: readonly { rel: string }[]): Map<string, ShardIndexEntry> {
  const keyOf = new Map<string, string | null>();
  const membersByKey = new Map<string, number>();

  for (const f of files) {
    const idx = f.rel.lastIndexOf("/");
    const name = idx === -1 ? f.rel : f.rel.slice(idx + 1);
    const dirPrefix = idx === -1 ? "" : f.rel.slice(0, idx + 1);
    const group = shardGroup(name);
    const key = group === null ? null : `${dirPrefix}|${group.prefix}|${group.total}`;
    keyOf.set(f.rel, key);
    if (key !== null) membersByKey.set(key, (membersByKey.get(key) ?? 0) + 1);
  }

  const index = new Map<string, ShardIndexEntry>();
  for (const f of files) {
    const key = keyOf.get(f.rel) ?? null;
    index.set(f.rel, { key, size: key === null ? 1 : (membersByKey.get(key) ?? 1) });
  }
  return index;
}
