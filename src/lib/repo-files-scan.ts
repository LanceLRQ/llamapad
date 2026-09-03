import { PART_META_SUFFIX, PART_SUFFIX } from "./download-part";
import { repoDirOf } from "./repo-path";

/**
 * 档案详情页 local/strays 计算（批 A 任务，原地从
 * `app/api/v1/repos/[id]/files/route.ts` 搬出）：route 里的逻辑测不了，
 * 下沉成纯函数后才能覆盖 I3/I5 两条回归。
 *
 * 只 import 两个零依赖的纯逻辑模块：`repo-path.ts` 的 `repoDirOf`，与
 * `download-part.ts` 的两个后缀常量（下载器落盘用的同一份定义，这里认出
 * 半成品用于过滤，见 isPartial）。
 */

/** scanTree 返回项的结构性子集：只取本文件用得到的字段，不把
 *  fsScanner 的 FolderFiles/ModelFile 整个类型拖进来。`ino` 可选——只有真实
 *  扫描（fsScanner.scanTree）才带，旧夹具/调用方不传时 sharedWith 计算
 *  自然退化成「不参与任何共用组」，不强求所有调用方补齐这个字段 */
export interface ScanNode {
  folder: string;
  files: { rel: string; size: number; ino?: number }[];
}

export interface RepoFilesScan {
  /** sharedWith：全盘与本文件同 ino（硬链接）的其他路径（本地权重迁移批③
   *  任务 15，设计 §9.1 共用标注）；没有 ino 信息或没有同 ino 的其他文件时
   *  为空数组，不是 undefined——下游（repo-files-view.ts）按空数组处理 */
  local: { rel: string; size: number; sharedWith: string[] }[];
  strays: { file: string; rel: string; size: number; inRepoDir: string | null }[];
}

function basename(rel: string): string {
  return rel.slice(rel.lastIndexOf("/") + 1);
}

/** .part / .part.meta.json 半成品：不算「已下载」，也不该被归位——正在写的
 *  文件既不是完整的本地文件，也不是能安全搬动的散落文件 */
function isPartial(rel: string): boolean {
  return rel.endsWith(PART_SUFFIX) || rel.endsWith(PART_META_SUFFIX);
}

/**
 * 计算档案详情页的 local / strays 两路。
 *
 * - local：本档案目录（含子目录）内的完整文件
 * - strays：全盘同名但不在**本**档案目录内的文件，标出其所属档案
 *   （`inRepoDir`，不属于任何档案则为 null）——别的档案里的同名文件不算
 *   「已经在位」，也不再像 I3 时代那样被整体排除在候选之外，理由见下方
 *   实现处注释
 *
 * 两路都先滤掉 `.part`/`.part.meta.json`（I5 裁定）：半成品被当成「已下载」
 * 会让详情页头「占盘 X GB」把正在写的文件也算进去，被当成「在别处」则会
 * 让「归位」把一个还没写完的文件搬进档案目录。
 */
export function scanRepoFiles(
  tree: readonly ScanNode[],
  targetDir: string,
  repoDirs: readonly string[],
): RepoFilesScan {
  // 全盘 ino → 路径清单，一次建好供下面的 local 逐条查——硬链接来的文件
  // 可能挂在任何位置（别的档案目录、游离位置），不能只在本档案目录内找
  const relsByIno = new Map<number, string[]>();
  for (const g of tree) {
    for (const f of g.files) {
      if (f.ino === undefined) continue;
      const list = relsByIno.get(f.ino);
      if (list === undefined) relsByIno.set(f.ino, [f.rel]);
      else list.push(f.rel);
    }
  }
  const sharedWithOf = (f: { rel: string; ino?: number }): string[] =>
    f.ino === undefined ? [] : (relsByIno.get(f.ino) ?? []).filter((rel) => rel !== f.rel);

  const local = tree
    .filter((g) => g.folder === targetDir || g.folder.startsWith(`${targetDir}/`))
    .flatMap((g) => g.files)
    .filter((f) => !isPartial(f.rel))
    .map((f) => ({ rel: f.rel, size: f.size, sharedWith: sharedWithOf(f) }));

  // 本档案目录内已有同名文件时，全盘其他位置的同名文件不算 stray——用户
  // 已经有自己的一份，没必要再提示「在别处」
  const localNames = new Set(local.map((f) => basename(f.rel)));
  // 原先排除全部档案目录（`repoDirOf(...) === null`）是因为 planFileMove 拒绝从
  // 档案目录移出，UI 给出的归位候选必须是服务端愿意接受的子集。本批引入硬链接后
  // 这个前提变了：别的档案里的文件不能「移」但可以「链接」，排除它等于把
  // 「两个仓库共用一份文件」这个最值钱的场景挡在门外。改为标出所属档案，
  // 由 acquire-match.actionsFor 决定它只能 link。
  const strays = tree
    .filter((g) => repoDirOf(g.folder, [targetDir]) === null) // 只排除本档案
    .flatMap((g) => g.files.map((f) => ({ f, dir: repoDirOf(g.folder, repoDirs) })))
    .filter(({ f }) => !isPartial(f.rel))
    .filter(({ f }) => !localNames.has(basename(f.rel)))
    .map(({ f, dir }) => ({ file: basename(f.rel), rel: f.rel, size: f.size, inRepoDir: dir }));

  return { local, strays };
}
