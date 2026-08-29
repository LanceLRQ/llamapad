/**
 * 文件元信息表搜索/排序纯逻辑（M16 T6）：file-meta-table.tsx 的搜索框 +
 * 排序下拉共用，对齐 lib/file-list.ts（files-table.tsx 同款）的既有做法
 * 抽出来单测。
 *
 * 与 file-list.ts 的关键差异：元信息表展示的就是含命名空间前缀的完整
 * path（"main/xxx.gguf"），关键字匹配这里用完整 path，不像文件表那样只
 * 匹配 basename——用户在元信息表里搜索本就是在按它展示出来的文本找。
 */

export type FileMetaSortKey = "name" | "size";
export type FileMetaSortDir = "asc" | "desc";

export interface FileMetaQuery {
  keyword: string;
  sort: FileMetaSortKey;
  dir: FileMetaSortDir;
}

/**
 * 关键字（大小写不敏感，匹配完整 path）过滤 + 按字段排序，不修改入参数组。
 *
 * size 为 null（孤儿记录，物理文件已不在磁盘上）只在**按大小排序**时恒排
 * 在末尾，不论升降序——把"文件已经没了"的记录混进体积序列中间没有意义。
 * 按名称排序时孤儿必须留在字母序本来的位置：名字仍然有效，用户是照着
 * 字母找这一条的，把它踢到表尾会让人误以为记录整个没了；「状态」列已经
 * 明确标了「缺失」，不需要再用排序位置重复表达一遍。
 */
export function applyFileMetaQuery<T extends { path: string; size: number | null }>(
  entries: readonly T[],
  query: FileMetaQuery,
): T[] {
  const keyword = query.keyword.trim().toLowerCase();
  const filtered = keyword === "" ? [...entries] : entries.filter((e) => e.path.toLowerCase().includes(keyword));

  const factor = query.dir === "asc" ? 1 : -1;
  filtered.sort((a, b) => {
    if (query.sort === "size") {
      if (a.size === null && b.size === null) return 0;
      if (a.size === null) return 1;
      if (b.size === null) return -1;
      return factor * (a.size - b.size);
    }
    return factor * (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  });
  return filtered;
}
