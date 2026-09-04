import { realpathSync } from "node:fs";
import { normalize, relative, sep } from "node:path";
import {
  actionsFor,
  pairsWithRemote,
  SHA256_PATTERN,
  type AcquireAction,
  type CandidateFacts,
  type CandidateLocation,
  type DriftState,
  type RemoteFileRef,
} from "../lib/acquire-match";
import { repoDirOf } from "../lib/repo-path";
import type { ModelRefField } from "./filesApi";
import { globMatchesPath, hasGlob } from "./fsScanner";

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

/** realpath，解析不了就原样返回（目录不存在、无权限等）——调用方要的是「尽量
 *  规范化」，不是一个额外的失败分支 */
function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
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
 * 第二道重验：源与远端条目**成对**，且远端有可用 oid、本地大小与远端声明一致
 * （迁移设计 §8.1）。返回入队要用的期望 sha256——常规项是已验证可用的远端 oid
 * （必然非空），手动关联项是 null。
 *
 * 返回值而不是 void 是刻意的：下游（download/manager.ts 的 `EnqueueLocalItem.sha256`
 * 与 localAcquire 的免比对分支）用「local 任务且入队时 sha256 为 NULL」当作
 * 手动关联的判据，这条推导完全依赖「常规 local 任务的 oid 非空」这个不变量。
 * 把 oid 从这里返回，等于让那个不变量由**类型**兜住：调用方无法一边跳过校验
 * 一边拿到非空 oid，也不必在路由里重复一次 `SHA256_PATTERN` 判定。
 *
 * **手动关联（规格 §7）把配对也一并放宽**，不只是大小与内容：§7.1 明确写着
 * 「能关联不同名的文件（本地叫 qwen38-27b.gguf 也能关联到
 * Qwen3.8-27B-UD-Q4_K_XL.gguf）」，§7.2 的候选池同样是「不限名、不限大小」。
 * 若这里仍要求成对，改过名又没有缓存哈希的文件（正是手动关联最典型的处境）
 * 会被判 MISMATCH，整条逃生口就是死的。放宽的边界仍然只是「内容/身份证据」
 * 这一类，路径范围、档案归属、动作矩阵、符号链接解析全部照旧（规格 §8）。
 */
export function assertRemoteMatch(
  remote: RemoteFileRef,
  local: { basename: string; fullSha256: string | null; size: number },
  opts: { manual: boolean },
): string | null {
  if (opts.manual) return null;

  if (!pairsWithRemote(remote, local)) {
    // 少了这一条，客户端可以把任意同尺寸文件塞给任意远端条目：服务端必须自己
    // 确认「这个源确实配得上这个远端文件」，判据与扫描侧共用 pairsWithRemote
    throw new AcquireGuardError("MISMATCH", `源文件与远端条目对不上: ${remote.path}`);
  }
  if (remote.oid === undefined || !SHA256_PATTERN.test(remote.oid) || local.size !== remote.size) {
    throw new AcquireGuardError("MISMATCH", "本地文件与远端声明不一致（大小或内容校验值）");
  }
  return remote.oid;
}

/**
 * models 根内的相对路径（"/" 分隔，与 repoDirOf / buildRefMap / 模型配置字段
 * 同口径）；根外或恰好就是根本身时为 null。
 *
 * 根也取 realpath 再比：源路径已经去过符号链接、根却没有的话，models 根本身
 * 含符号链接段的部署（macOS 的 /var → /private/var 就是这个形态）会把根内的
 * 文件误判成「根外」。解析不了（测试夹具给的假路径、目录刚被删）就退回原样。
 *
 * 导出是因为 acquire 路由要用它算 `referenced`（查 buildRefMap）与 glob 预检的
 * 键——那两处必须与 assertActionAllowed 内部的位置判定同一口径，否则会出现
 * 「矩阵认为它在根内、引用表按另一个键去查」的错位。
 */
export function modelsRelOf(modelsRoot: string, realSourcePath: string): string | null {
  const root = realpathSafe(modelsRoot);
  if (!isInside(root, realSourcePath)) return null;
  const rel = relative(normalize(root), normalize(realSourcePath)).split(sep).join("/");
  return rel === "" ? null : rel;
}

/**
 * 落进 models 树的某个相对路径，会被哪些**glob 形态**的模型配置字段收进去。
 *
 * 判据是「这个 glob 真的覆盖这个路径」，不是「库里存在任意 glob」——后者会因为
 * 库里有个无关的分片组就把无关的单文件操作也一并拦下。匹配一律走
 * {@link globMatchesPath}（fsScanner 导出，与 resolveModelFiles 的 glob 分支
 * 同一套字符映射），不另写第四份。
 *
 * 为什么用纯字符串匹配而不是 buildRefMap 的读盘展开：
 * - buildRefMap 展开后只留下 `{modelName, field}`，「这条引用来自 glob」这个
 *   事实在展开的那一刻就丢了，从它的结果里根本回答不了本函数的问题；
 * - 目标侧（{@link globExtensionRefs}）问的是「文件**还没落盘**时会不会被收走」，
 *   读盘展开必然扑空，字符串匹配是唯一可行的手段；
 * - 源侧要与 refRewrite.ts 完成回调里那道 GLOB_REF 拒绝**逐字同判**，两边都用
 *   globMatchesPath 才能保证「预检放行的，完成回调也不会再拒」——否则又会出现
 *   文件已经搬走才报错的那个洞。
 */
export function globRefsCovering(
  fields: readonly ModelRefField[],
  rel: string,
): ModelRefField[] {
  return fields.filter((f) => hasGlob(f.configured) && globMatchesPath(f.configured, rel));
}

/**
 * 落盘前预检：被 glob 配置覆盖的分片不许走 move-with-refs（审查 I-2）。
 *
 * refRewrite.ts 里有同一道拒绝，但它跑在**完成回调**里——那时 rename 早已做完，
 * 分片先被搬走、再抛错、再被 catch 成一条 download.failed 事件，任务行仍是
 * completed，结果正是规格想避免的那件事（组内其余分片解析被毁），只多了一条
 * 埋在事件列表里的日志。这一道跑在入队之前，此刻物理文件还在原处，拒绝是真的
 * 拒绝。那一道保留不动，作为纵深防御的第二层。
 *
 * 单文件改指救不了分片组：`main/m1-*.gguf` 改写成一个具体新路径会毁掉组内其余
 * 分片的解析，这种情况该走档案页的「归位」（planFileMove 本就是整组语义）。
 */
export function assertNoGlobRefOnSource(
  fields: readonly ModelRefField[],
  sourceRel: string,
): void {
  const hit = globRefsCovering(fields, sourceRel)[0];
  if (hit === undefined) return;
  throw new AcquireGuardError(
    "ACTION_NOT_ALLOWED",
    `GLOB_REF: 模型 ${hit.modelName} 的 ${hit.field} 是分片 glob（${hit.configured}），` +
      `移走其中一片会毁掉整组解析，请到档案页用「归位」整组移动`,
  );
}

/**
 * 目标侧的 glob 扩组检测（审查 I-4）：本次落盘会不会让某个既有模型配置**多收
 * 一片**。
 *
 * 这是合法操作，不拒绝——档案目录里放一个新 .gguf 本来就是 acquire 要做的事，
 * 此刻拒绝只会让用户无路可走。但必须留痕：实测复现过「模型 x 配置
 * `hf/u/r/w-*.gguf`，把 loose 里的第三片搬进去之后解析从 2 片变成 3 片，事件表
 * 零提示」，另一个模型的文件集合被静默改写了。
 *
 * `targetExists` 由调用方实测：目标已经有文件时，本次是覆盖（或被
 * partitionExistingTargets 整个跳过），模型的文件集合不会变大，不算扩组。
 *
 * 该洞对 download / copy / link / move 一字不差地成立（是「档案目录 + glob 配置」
 * 这个组合的固有属性），所以调用方对所有落进档案目录的动作都该问一遍，不只
 * move-with-refs。
 */
export function globExtensionRefs(
  fields: readonly ModelRefField[],
  targetRel: string,
  targetExists: boolean,
): ModelRefField[] {
  if (targetExists) return [];
  return globRefsCovering(fields, targetRel);
}

/** 目标侧 glob 扩组的事件 kind（独立于 download.*：它说的不是任务状态，
 *  而是「另一个模型的文件集合被这次操作改写了」） */
export const GLOB_EXTENSION_EVENT = "acquire.glob_extension";

/** 扩组事件的消息文案：说清落点、被牵连的模型与那条 glob */
export function describeGlobExtension(
  targetRel: string,
  refs: readonly ModelRefField[],
): string {
  const who = refs.map((r) => `${r.modelName} 的 ${r.field}（${r.configured}）`).join("、");
  return `落盘 ${targetRel} 会被既有 glob 配置多收一片：${who}`;
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
 * 现在同时覆盖三维事实——位置（在不在 models 根 / 在不在某个档案目录内）、
 * 版本关系（本地内容与远端声明是否相符）、引用状态（是否被某个模型配置引用），
 * 三者合成 `CandidateFacts` 后喂给与前端同一份 `actionsFor` 复算可选动作
 * （矩阵只有 `lib/acquire-match.ts` 一份真源，这里不复写判定逻辑）。
 *
 * 位置仍然全部现场实测，不取自前端：`isInside(modelsRoot, real)` 给
 * inModelsRoot，models 根内的相对路径过 `repoDirOf` 给 inRepoDir。版本关系与
 * 引用状态改由调用方在 ctx 里给出——它们的判定依据（file_meta 缓存的哈希、
 * models 表的引用关系）不在这个函数的职责范围内，在这里重新查一遍等于另开
 * 一条判定路径；但同「位置」一样，**必须是调用方现场实测的结果**，见下方
 * ctx 类型上的注释。
 *
 * 手动关联（规格 §7）只放宽这三维里的版本关系一维——档案目录归属与引用状态
 * 这两条继续原样生效，越权路径、别的档案里的文件、非法动作一条都过不去
 * （规格 §8「安全边界」）。这里先把三维接口铺好；手动关联怎么把「已知版本
 * 不符、用户确认要用」这件事接进 drift 维度，由后续任务接线。
 *
 * 返回实测到的 `location`（不含 drift/referenced）供调用方接着用（入队的
 * `sameFs` 就是 inModelsRoot，不必再算一遍）。
 *
 * 必须传**已解析符号链接**的真实路径（resolveAllowedRealPath 的返回值）：按未解析
 * 的路径判位置，一个指向档案目录内文件的符号链接会被当成游离文件放行。
 */
export function assertActionAllowed(
  remote: RemoteFileRef,
  action: AcquireAction,
  ctx: {
    modelsRoot: string;
    realSourcePath: string;
    repoDirs: readonly string[];
    /** 与远端的版本关系。必须由调用方现场实测得出（比对 file_meta 缓存的
     *  真实 size/oid），绝不能取自请求体——前端算出的 drift 只是给用户看的
     *  展示值，篡改成 "same" 就能绕开 version-drift 限制搬走一份错误内容 */
    drift: DriftState;
    /** 是否被某个模型配置引用。必须由调用方现场查服务端的引用关系（如
     *  buildRefMap）得出，同样不能取自请求体——伪造 referenced:false 就能
     *  让本该走 move-with-refs 的源改走裸 move，把引用它的模型配置搬空 */
    referenced: boolean;
  },
): CandidateLocation {
  // 位置口径与 modelsRelOf 同一份（根取 realpath 再比、rel 用 "/" 分隔），
  // 调用方算 referenced / glob 预检时用的也是它，不会与这里错位
  const rel = modelsRelOf(ctx.modelsRoot, ctx.realSourcePath);
  const location: CandidateLocation = {
    inModelsRoot: isInside(realpathSafe(ctx.modelsRoot), ctx.realSourcePath),
    inRepoDir: rel === null ? null : repoDirOf(rel, ctx.repoDirs),
  };

  const facts: CandidateFacts = { ...location, drift: ctx.drift, referenced: ctx.referenced };
  if (!actionsFor(remote, facts).actions.includes(action)) {
    throw new AcquireGuardError(
      "ACTION_NOT_ALLOWED",
      `该位置不允许此动作: ${action}（${ctx.realSourcePath}）`,
    );
  }
  return location;
}
