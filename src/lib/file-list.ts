/**
 * 文件列表过滤/排序纯函数（UX P1 U21）：files-table.tsx 的搜索框 + 排序
 * 下拉共用同一份逻辑，抽出便于单测（无 DOM 依赖）。
 */

/** applyFileQuery 只依赖这四个字段，与 FilesEntry（files-table.tsx）结构兼容 */
export interface FileListEntry {
  rel: string;
  size: number;
  mtime: number;
  refs: number;
}

export type FileSortKey = "name" | "size" | "mtime";
export type FileSortDir = "asc" | "desc";

export interface FileQuery {
  keyword: string;
  sort: FileSortKey;
  dir: FileSortDir;
}

/** relPath 最后一段（文件名），用于关键字匹配——与命名空间前缀无关 */
function fileName(rel: string): string {
  const idx = rel.lastIndexOf("/");
  return idx === -1 ? rel : rel.slice(idx + 1);
}

/**
 * 关键字（大小写不敏感，匹配文件名）过滤 + 按字段排序，不修改入参数组。
 */
export function applyFileQuery<T extends FileListEntry>(files: readonly T[], query: FileQuery): T[] {
  const keyword = query.keyword.trim().toLowerCase();
  const filtered = keyword === "" ? [...files] : files.filter((f) => fileName(f.rel).toLowerCase().includes(keyword));

  const factor = query.dir === "asc" ? 1 : -1;
  filtered.sort((a, b) => {
    switch (query.sort) {
      case "size":
        return factor * (a.size - b.size);
      case "mtime":
        return factor * (a.mtime - b.mtime);
      case "name":
      default:
        return factor * (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
    }
  });
  return filtered;
}
