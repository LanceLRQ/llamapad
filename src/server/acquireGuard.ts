import { realpathSync } from "node:fs";
import { normalize, relative, sep } from "node:path";
import { actionsFor, type AcquireAction, type CandidateLocation, type RemoteFileRef } from "../lib/acquire-match";
import { repoDirOf } from "../lib/repo-path";

/**
 * acquire 的源路径守卫（设计 §8.1）
 *
 * 扫描结果不入库，用户确认时源路径由前端带回——所以服务端必须自己再验一遍，
 * 不能信前端。这与 README-LLM 批「前后端各回证一次」是同一个模式。
 *
 * 目录边界判定复用 core/paths 的语义：相等或以 root + 分隔符开头，
 * 纯字符串前缀不算（防 /host-models 与 /host-models2 误匹配）。
 */
export class AcquireGuardError extends Error {
  constructor(
    readonly code: "OUT_OF_SCOPE" | "NOT_FOUND" | "MISMATCH" | "ACTION_NOT_ALLOWED",
    message: string,
  ) {
    super(message);
    this.name = "AcquireGuardError";
  }
}

/** 判断 p 是否位于 root 之内（相等，或以 root+目录分隔符 开头）；两者都先 normalize */
export function isInside(root: string, p: string): boolean {
  const r = normalize(root);
  const t = normalize(p);
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** 纯字符串级判定，不做任何 IO——`..` 穿越经 normalize 消解后即可判定，
 *  不需要文件真实存在（route 层会在这之后才 statSync 验存在性）。 */
export function assertSourceAllowed(sourcePath: string, allowedRoots: readonly string[]): void {
  if (!allowedRoots.some((root) => isInside(root, sourcePath))) {
    throw new AcquireGuardError(
      "OUT_OF_SCOPE",
      `源路径不在允许范围内: ${sourcePath}`,
    );
  }
}

/**
 * 符号链接逃逸防护：assertSourceAllowed 只按字符串前缀判定，挡不住范围内的
 * 符号链接指向范围外——例如 /host-models/evil 是一个指向 /etc 的符号链接，
 * 字符串判定会放行，但 statSync/读取实际落到的是 /etc 下的文件。这里对
 * realpath 之后的真实落点重新判一遍范围，判定手法与 docs.ts 的符号链接
 * 逃逸防护同源（realpath 前缀比较）。
 *
 * **返回解析出的 real（而不是 void）是本函数存在的核心理由，不是顺手**：
 * 校验通过之后，调用方必须拿这个已经去符号链接化的规范路径去入队/落库，
 * 不能接着用调用前的原始 sourcePath——那样会形成 TOCTOU 窗口（此处验证时
 * 符号链接指向范围内，但任务真正执行往往在队列排一段时间之后，期间符号
 * 链接可以被改指向范围外的任意文件；操作系统届时按*彼时*的链接目标解析，
 * 校验形同虚设）。把 real 返回并用它落库，等于让「验证」与「将来会被操作
 * 的路径」在同一个原子读点上锁死，之后不管符号链接怎么改都不影响已经入队
 * 的这条任务。
 *
 * 要求源路径已经存在（route 层调用顺序：先 assertSourceAllowed → statSync
 * 确认存在 → 这里）；解析失败（含允许根本身解析失败）一律判定越界，不吞错
 * 兜底成放行。
 */
export function resolveAllowedRealPath(sourcePath: string, allowedRoots: readonly string[]): string {
  let real: string;
  try {
    real = realpathSync(sourcePath);
  } catch {
    throw new AcquireGuardError("NOT_FOUND", `源路径无法解析: ${sourcePath}`);
  }

  const ok = allowedRoots.some((root) => {
    try {
      return isInside(realpathSync(root), real);
    } catch {
      return false;
    }
  });
  if (!ok) {
    throw new AcquireGuardError("OUT_OF_SCOPE", `源路径的真实位置不在允许范围内: ${sourcePath}`);
  }
  return real;
}

/**
 * 动作矩阵重验（设计 §4.3 / D13「前端篡改绕不过去」）。
 *
 * 前三道重验只问「这个源能不能读」，不问「这个位置允许对它做什么」。少了这一道，
 * 构造 `{action:"move", sourceHostPath:<别的档案里的文件>}` 就能绕过矩阵：源在
 * models 根内 → `sameFs` 为真 → 执行器直接 renameSync 把文件从那个档案搬走，而且
 * **不走 fileMove.ts 的事务重写**，那个档案里指向该文件的模型配置当场变成悬空
 * 引用（`planFileMove` 拒绝这条路径正是为了避免这个）。
 *
 * 位置事实全部现场实测，不取自前端：`isInside(modelsRoot, real)` 给 inModelsRoot，
 * models 根内的相对路径过 `repoDirOf` 给 inRepoDir，然后用与前端同一份
 * `actionsFor` 复算可选动作。返回这两项供调用方接着用（入队的 `sameFs` 就是
 * inModelsRoot，不必再算一遍）。
 *
 * 必须传**已解析符号链接**的真实路径（resolveAllowedRealPath 的返回值）：按未解析
 * 的路径判位置，一个指向档案目录内文件的符号链接会被当成游离文件放行。
 */
export function assertActionAllowed(
  remote: RemoteFileRef,
  action: AcquireAction,
  ctx: { modelsRoot: string; realSourcePath: string; repoDirs: readonly string[] },
): CandidateLocation {
  const inModelsRoot = isInside(ctx.modelsRoot, ctx.realSourcePath);
  // rel 用 "/" 分隔：repoDirOf 与档案目录清单（repoTargetDir）都是这个口径
  const rel = inModelsRoot
    ? relative(normalize(ctx.modelsRoot), normalize(ctx.realSourcePath)).split(sep).join("/")
    : null;
  const location: CandidateLocation = {
    inModelsRoot,
    inRepoDir: rel === null || rel === "" ? null : repoDirOf(rel, ctx.repoDirs),
  };

  if (!actionsFor(remote, location).actions.includes(action)) {
    throw new AcquireGuardError(
      "ACTION_NOT_ALLOWED",
      `该位置不允许此动作: ${action}（${ctx.realSourcePath}）`,
    );
  }
  return location;
}
