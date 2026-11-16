import { realpathSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { LocalCandidate } from "../lib/acquire-match";
import { PART_META_SUFFIX, PART_SUFFIX } from "../lib/download-part";
import { repoDirOf } from "../lib/repo-path";
import { isInside } from "./acquireGuard";
import { scanTree, type FolderFiles } from "./fsScanner";

/**
 * 深度扫描的候选构建（设计 §8，任务 12）：models 根 + 自定义目录两路扫描
 * 汇成统一的 LocalCandidate 数组，供 lib/acquire-match 逐远端文件做 L1 匹配。
 *
 * 全部只读——不做任何哈希计算。models 根内的候选优先经调用方注入的 resolveOid
 * 解析 oid（生产是 server/localOid.resolveLocalOid：file_meta 缓存优先，其次
 * hf CLI 下载边车），不传该注入点时退回 fullSha256ByRel（file_meta 缓存快照，
 * 见 fileMeta.listFileMetaRows）；models 外的候选没有缓存，fullSha256 恒为
 * null，真正的哈希校验（L2）留给用户确认之后的 server/download/localAcquire.ts。
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
  /** 根内候选的 oid 解析（rel + 绝对路径 → oid）。生产传 server/localOid.resolveLocalOid
   *  的封装（内部已经把 fullSha256ByRel 的缓存值当第一优先级传给它，边车只是兜底），
   *  测试可注入假实现；不传时退回 fullSha256ByRel 查表（等价于旧行为）。读盘由
   *  调用方在这个注入点内完成，本模块自身仍是零 IO。
   *
   *  复核修复 L-1：一旦这个函数被提供（不是 undefined），它对某个 rel 的返回值
   *  就是终局——包括返回 null（resolveLocalOid 的新鲜度校验拒掉了陈旧缓存）。
   *  不能再退回 fullSha256ByRel 这份未经校验的原始映射，否则 K-2 的新鲜度校验
   *  在 scan 这条路径上等于白做：resolveLocalOid 好不容易拒掉的陈旧哈希，会被
   *  这里的兜底原样捞回来 */
  resolveOid?: (rel: string, absPath: string) => string | null;
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

/** 自定义目录可能是手填的符号链接，按实际位置归类，并排除非目录。 */
function realDirectoryPath(path: string): string | null {
  try {
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

export function collectScanCandidates(args: ScanCandidatesArgs): ScanCandidatesResult {
  const { modelsRoot, extraHostDirs, repoDirs, fullSha256ByRel, referencedRels, resolveOid, toHost, toPanel } =
    args;
  const candidates: LocalCandidate[] = [];
  const seen = new Set<string>();

  function addCandidates(scanRoot: string, realRoot: string, groups: FolderFiles[], modelsPrefix: string | null): void {
    for (const group of groups) {
      for (const file of group.files) {
        const absPath = join(scanRoot, file.rel);
        const realPath = join(realRoot, file.rel);
        if (isPartial(file.rel) || seen.has(realPath)) continue;
        seen.add(realPath);
        const rel = modelsPrefix === null ? null : join(modelsPrefix, file.rel);
        candidates.push({
          absPath,
          rel,
          size: file.size,
          fullSha256: rel === null
            ? null
            : resolveOid !== undefined ? resolveOid(rel, absPath) : (fullSha256ByRel.get(rel) ?? null),
          inRepoDir: rel === null ? null : repoDirOf(dirname(rel), repoDirs),
          inModelsRoot: rel !== null,
          hostPath: toHost(absPath),
          referenced: rel !== null && referencedRels.has(rel),
        });
      }
    }
  }

  const modelsRealRoot = realDirectoryPath(modelsRoot) ?? modelsRoot;
  addCandidates(modelsRoot, modelsRealRoot, scanTree(modelsRoot), "");

  const unreachable: string[] = [];
  for (const hostDir of extraHostDirs) {
    let panelDir: string;
    try {
      panelDir = toPanel(hostDir);
    } catch {
      unreachable.push(hostDir);
      continue;
    }
    const realDir = realDirectoryPath(panelDir);
    if (realDir === null) {
      unreachable.push(hostDir);
      continue;
    }
    let groups: FolderFiles[];
    try {
      groups = scanTree(realDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EACCES" && code !== "EPERM") throw error;
      unreachable.push(hostDir);
      continue;
    }
    const modelsPrefix = isInside(modelsRealRoot, realDir) ? relative(modelsRealRoot, realDir) : null;
    addCandidates(panelDir, realDir, groups, modelsPrefix);
  }

  const unarchived = candidates.filter((c) => c.inModelsRoot && c.inRepoDir === null);
  return { candidates, unreachable, unarchived };
}
