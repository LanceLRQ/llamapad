import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LocalCandidate } from "../lib/acquire-match";
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
 * 自定义目录不可达（toPanel 换算失败，或换算出的路径在面板容器内不存在）
 * 不算错误，收进 unreachable：面板是容器，只看得见 compose 挂进来的路径，
 * 笼统报「目录不存在」会让用户误以为路径打错了。
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
  /** panel 视角 → host 视角换算；本模块不用它做判定，纯粹随候选带到前端 */
  toHost: (panelPath: string) => string;
  /** host 视角 → panel 视角换算；抛错视为该目录不可达 */
  toPanel: (hostPath: string) => string;
}

export interface ScanCandidatesResult {
  candidates: LocalCandidate[];
  /** 换算失败或换算后在面板容器内不存在的自定义目录（宿主机视角原样返回） */
  unreachable: string[];
}

export function collectScanCandidates(args: ScanCandidatesArgs): ScanCandidatesResult {
  const { modelsRoot, extraHostDirs, repoDirs, fullSha256ByRel, toHost, toPanel } = args;
  const candidates: LocalCandidate[] = [];

  for (const g of scanTree(modelsRoot)) {
    for (const f of g.files) {
      const absPath = join(modelsRoot, f.rel);
      candidates.push({
        absPath,
        rel: f.rel,
        size: f.size,
        fullSha256: fullSha256ByRel.get(f.rel) ?? null,
        inRepoDir: repoDirOf(g.folder, repoDirs),
        inModelsRoot: true,
        hostPath: toHost(absPath),
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
    if (!existsSync(panelDir)) {
      unreachable.push(hostDir);
      continue;
    }
    for (const g of scanTree(panelDir)) {
      for (const f of g.files) {
        const absPath = join(panelDir, f.rel);
        candidates.push({
          absPath,
          rel: null,
          size: f.size,
          fullSha256: null, // models 外不登记 file_meta，没有缓存哈希
          inRepoDir: null,
          inModelsRoot: false,
          hostPath: toHost(absPath),
        });
      }
    }
  }

  return { candidates, unreachable };
}
