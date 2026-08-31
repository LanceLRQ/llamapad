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

/** scanTree 返回项的结构性子集：只取本文件用得到的两个字段，不把
 *  fsScanner 的 FolderFiles/ModelFile 整个类型拖进来 */
export interface ScanNode {
  folder: string;
  files: { rel: string; size: number }[];
}

export interface RepoFilesScan {
  local: { rel: string; size: number }[];
  strays: { file: string; rel: string; size: number }[];
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
 * - strays：全盘同名但不在**任何**档案目录内的文件（I3 裁定：不只排除本
 *   档案目录——`createProfile` 支持同一个 repo 挂在不同 baseDir 下，
 *   若只排除本档案目录，档案 B 会把档案 A 目录里的文件报成「在别处」，
 *   而服务端 `planFileMove` 拒绝 `from` 落在任何档案目录内的请求，点了
 *   必然 400。UI 能给出的「归位」候选集合必须是服务端愿意接受的子集）
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
  const local = tree
    .filter((g) => g.folder === targetDir || g.folder.startsWith(`${targetDir}/`))
    .flatMap((g) => g.files)
    .filter((f) => !isPartial(f.rel))
    .map((f) => ({ rel: f.rel, size: f.size }));

  // 本档案目录内已有同名文件时，全盘其他位置的同名文件不算 stray——用户
  // 已经有自己的一份，没必要再提示「在别处」
  const localNames = new Set(local.map((f) => basename(f.rel)));
  const strays = tree
    .filter((g) => repoDirOf(g.folder, repoDirs) === null)
    .flatMap((g) => g.files)
    .filter((f) => !isPartial(f.rel))
    .filter((f) => !localNames.has(basename(f.rel)))
    .map((f) => ({ file: basename(f.rel), rel: f.rel, size: f.size }));

  return { local, strays };
}
