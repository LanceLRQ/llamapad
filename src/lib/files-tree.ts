import type { FileSortDir, FileSortKey } from "./file-list";

/**
 * 多级目录文件页的纯逻辑（阶段 3b C3/C4）：面包屑分段 + 子目录聚合/递归计数。
 * 与 lib/files-view.ts（负责"当前在哪个视图"）分工不同，这里负责"给定一棵
 * scanTree/getFilesTree 结果树 + 一个当前路径，子目录长什么样"——组件只管
 * 渲染，vitest 是 environment: "node" 测不了组件，判定必须下沉到这里。
 */

/** childFolders / sortFolderRows 只依赖这两个字段，与 fsScanner.FolderFiles
 * 结构兼容（不引 server 模块，客户端组件可以直接用这份类型） */
export interface FolderTreeEntry {
  folder: string;
  files: readonly { size: number }[];
}

/** 面包屑一段：展示名 + 点击后要跳转到的完整路径（累积到这一段为止） */
export interface BreadcrumbSegment {
  name: string;
  path: string;
}

/**
 * 目录路径 → 面包屑分段列表。根节点（"models"）不在返回值里——它是固定的
 * 第一个面包屑节点、永远链接到根目录（path: ""），由调用方直接渲染，不需要
 * 这个纯函数每次都吐出一个"名字是谁"还得由调用方翻译的特殊节点。
 */
export function breadcrumbSegments(folder: string): BreadcrumbSegment[] {
  if (folder === "") return [];
  const parts = folder.split("/");
  return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join("/") }));
}

/** 一个子目录行：名字（不含父路径前缀）+ 完整路径 + 递归文件数/占用 */
export interface FolderRow {
  name: string;
  path: string;
  fileCount: number;
  bytes: number;
}

/**
 * 给定 current 路径，列出它的直接子目录，每个子目录的 fileCount/bytes 都是
 * **递归**总数（含更深层子目录）——这一点是 C3 的核心要求：用户点开
 * "qwen3.6" 不该先看到「0 个文件」再发现里面全是子目录，那比不显示数字更
 * 让人困惑。
 *
 * current === "" 时返回的是"一级目录"清单（models 根的直接子目录），
 * 这正是左侧二级栏要的数据；current 为任意深层路径时返回该目录的直接
 * 子目录——同一个函数覆盖 C3（根一级目录聚合）与 C4（当前目录下钻一层）
 * 两个场景，没有必要为"根"和"任意深度"分别写一套聚合逻辑，它们本质上是
 * 同一件事："current 的下一层有什么"。
 *
 * tree 里 folder === current 的条目是"当前目录自己"，不是它的子目录，
 * 这里排除掉（它的 files 由调用方另外取，见 files-view.ts 的
 * treeByFolder 用法）。folder === "" 的根散落文件同理：current === "" 时
 * 会被这条排除规则挡掉，不会把根自己算成"根的子目录"。
 */
export function childFolders(tree: readonly FolderTreeEntry[], current: string): FolderRow[] {
  const prefix = current === "" ? "" : `${current}/`;
  const byName = new Map<string, { fileCount: number; bytes: number }>();

  for (const g of tree) {
    if (g.folder === current) continue;
    if (!g.folder.startsWith(prefix)) continue;
    const rest = g.folder.slice(prefix.length);
    const name = rest.split("/")[0]!;
    const bytes = g.files.reduce((sum, f) => sum + f.size, 0);
    const agg = byName.get(name) ?? { fileCount: 0, bytes: 0 };
    agg.fileCount += g.files.length;
    agg.bytes += bytes;
    byName.set(name, agg);
  }

  return [...byName.entries()]
    .map(([name, agg]) => ({ name, path: prefix + name, ...agg }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * 目录行排序：复用文件表格已有的 FileSortKey（name/size/mtime），mtime
 * 对目录没有意义（一个目录的"修改时间"是它聚合出来的、不对应任何单一
 * 磁盘时间戳），退化为按名排序——而不是报错或忽略这个排序状态，目录行
 * 与文件行共用同一个 Toolbar 排序控件，用户切到"修改时间"时目录行不能
 * 消失或崩掉，只是排序键退化。
 */
export function sortFolderRows(rows: readonly FolderRow[], sort: FileSortKey, dir: FileSortDir): FolderRow[] {
  const factor = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (sort === "size") return factor * (a.bytes - b.bytes);
    return factor * (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  });
}

/**
 * 文件相对路径 → 它所在目录的完整路径（根下文件返回空串）。
 *
 * 必须按**最后一个** `/` 拆，不能取首段：多级目录落地后，
 * `qwen3.6/70b/m-00001.gguf` 所在的目录是 `qwen3.6/70b` 而不是 `qwen3.6`。
 * 取首段会同时造成两个错误——把父目录 `qwen3.6`（一个合法的移动目标）
 * 从候选里排掉，又把当前目录 `qwen3.6/70b` 留在候选里（选中它服务端会以
 * "目标目录与当前相同"拒绝）。服务端 filesApi.splitFolderRel 用的就是
 * lastIndexOf，这里与它保持同一口径。
 */
export function folderOfRel(rel: string): string {
  const slash = rel.lastIndexOf("/");
  return slash === -1 ? "" : rel.slice(0, slash);
}
