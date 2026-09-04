import { statSync } from "node:fs";
import { join } from "node:path";
import type { LocalCandidate } from "../lib/acquire-match";
import { PART_META_SUFFIX, PART_SUFFIX } from "../lib/download-part";
import { repoDirOf } from "../lib/repo-path";
import { scanTree } from "./fsScanner";

/**
 * 深度扫描的候选构建（设计 §8，任务 12）：models 根 + 自定义目录两路扫描
 * 汇成统一的 LocalCandidate 数组，供 lib/acquire-match 逐远端文件做 L1 匹配。
 *
 * 全部只读——不做任何哈希计算。models 根内的候选复用调用方传入的
 * fullSha256ByRel（file_meta 缓存快照，见 fileMeta.listFileMetaRows）；
 * models 外的候选没有缓存可言，fullSha256 恒为 null，真正的哈希校验（L2）
 * 留给用户确认之后的 server/download/localAcquire.ts。
 *
 * 自定义目录不可达（toPanel 换算失败，或换算出的路径在面板容器内不存在、
 * 或存在但不是目录）不算错误，收进 unreachable：面板是容器，只看得见 compose
 * 挂进来的路径，笼统报「目录不存在」会让用户误以为路径打错了。
 *
 * toHost/toPanel 由调用方注入而不是本模块直接依赖 server/pathMaps 单例，
 * 便于在没有 panel.yaml/挂载表的场景下单测（真实 fs + 假换算函数）。
 */
export interface ScanCandidatesArgs {
  /** panel 视角 models 根 */
  modelsRoot: string;
  /** 用户配置的自定义目录（宿主机视角） */
  extraHostDirs: readonly string[];
  /** 全部档案目录（相对 models 根），用于判定候选落在哪个档案内 */
  repoDirs: readonly string[];
  /** models 根内候选复用的完整 sha256 缓存：rel → fullSha256（无缓存为 null） */
  fullSha256ByRel: ReadonlyMap<string, string | null>;
  /** models 根相对路径的引用集合（server/filesApi.ts 的 buildRefMap 的键）。
   *  只对根内候选生效——根外文件不可能被 gguf_file 引用（ggufPathSchema 要求
   *  根内相对路径），塞进来也会被忽略 */
  referencedRels: ReadonlySet<string>;
  /** panel 视角 → host 视角换算；本模块不用它做判定，纯粹随候选带到前端 */
  toHost: (panelPath: string) => string;
  /** host 视角 → panel 视角换算；抛错视为该目录不可达 */
  toPanel: (hostPath: string) => string;
}

export interface ScanCandidatesResult {
  candidates: LocalCandidate[];
  /** 换算失败、换算后在面板容器内不存在、或存在但不是目录的自定义目录
   *  （宿主机视角原样返回） */
  unreachable: string[];
  /** 未归档候选池（规格 §7.2）：models 根内、不属于任何档案目录的文件，
   *  供手动关联弹层直接取用。深度扫描已经遍历过整棵树，这批是白拿的，
   *  不必为手动关联另开一次扫盘 */
  unarchived: LocalCandidate[];
}

/** .part / .part.meta.json 半成品不是候选：挪一个还没写完的文件进档案目录，
 *  得到的是一份坏权重。与 lib/repo-files-scan.ts 的 isPartial 共用同一份后缀
 *  常量（lib/download-part.ts），两处口径不能各写一份 */
function isPartial(rel: string): boolean {
  return rel.endsWith(PART_SUFFIX) || rel.endsWith(PART_META_SUFFIX);
}

/** 目录可读且确实是目录：自定义目录被填成一个**文件**时 existsSync 会通过，
 *  scanTree 随后 readdir 抛 ENOTDIR，整个 scan 请求 500——一条填错的目录不该
 *  拖垮整次扫描，归入 unreachable 那一路即可 */
function isReadableDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function collectScanCandidates(args: ScanCandidatesArgs): ScanCandidatesResult {
  const { modelsRoot, extraHostDirs, repoDirs, fullSha256ByRel, referencedRels, toHost, toPanel } = args;
  const candidates: LocalCandidate[] = [];

  for (const g of scanTree(modelsRoot)) {
    for (const f of g.files) {
      if (isPartial(f.rel)) continue;
      const absPath = join(modelsRoot, f.rel);
      candidates.push({
        absPath,
        rel: f.rel,
        size: f.size,
        fullSha256: fullSha256ByRel.get(f.rel) ?? null,
        inRepoDir: repoDirOf(g.folder, repoDirs),
        inModelsRoot: true,
        hostPath: toHost(absPath),
        referenced: referencedRels.has(f.rel),
      });
    }
  }

  const unreachable: string[] = [];
  for (const hostDir of extraHostDirs) {
    let panelDir: string;
    try {
      panelDir = toPanel(hostDir);
    } catch {
      unreachable.push(hostDir);
      continue;
    }
    if (!isReadableDir(panelDir)) {
      unreachable.push(hostDir);
      continue;
    }
    for (const g of scanTree(panelDir)) {
      for (const f of g.files) {
        if (isPartial(f.rel)) continue;
        const absPath = join(panelDir, f.rel);
        candidates.push({
          absPath,
          rel: null,
          size: f.size,
          fullSha256: null, // models 外不登记 file_meta，没有缓存哈希
          inRepoDir: null,
          inModelsRoot: false,
          hostPath: toHost(absPath),
          referenced: false, // models 根外恒为 false（见 LocalCandidate.referenced 注释）
        });
      }
    }
  }

  const unarchived = candidates.filter((c) => c.inModelsRoot && c.inRepoDir === null);
  return { candidates, unreachable, unarchived };
}
