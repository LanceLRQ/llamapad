/**
 * 本地获取的匹配与动作判定（设计 §4.2 / §4.3）
 *
 * 全部零 IO：size 来自 scanTree 已有的 stat，fullSha256 来自 file_meta 缓存。
 * 真正读盘的 L2 校验发生在用户确认之后，由 server/download/localAcquire.ts 承担。
 */

import { compareToRemote, type DriftState } from "./version-drift";

export type { DriftState };

/** 一次获取可以采取的手段 */
export type AcquireAction = "download" | "move" | "link" | "copy";

/** 动作受限的原因码，供 UI 解释为什么只能下载 */
export type AcquireRestriction = "none" | "no-oid" | "in-repo" | "outside-root";

/** 远端清单里的一个文件（HF LFS oid 即内容 sha256；非 LFS 文件没有） */
export interface RemoteFileRef {
  path: string;
  size: number;
  oid?: string;
}

/**
 * 动作矩阵真正消费的候选事实：只有「在不在 models 根内」「在不在某个档案目录内」
 * 这两项位置信息。{@link LocalCandidate} 是它的超集。
 *
 * 单独抽出来是为了服务端重验（`POST /repos/:id/acquire` 的第四道）：那里手里
 * 只有对源路径实测出来的这两项，没有 rel/hostPath 之类的展示字段，不该为了调用
 * `actionsFor` 而伪造一个完整候选。
 */
export interface CandidateLocation {
  /** 落在哪个档案的 targetDir 内；不在任何档案内为 null */
  inRepoDir: string | null;
  inModelsRoot: boolean;
}

/** 本地扫描出的一个候选文件 */
export interface LocalCandidate extends CandidateLocation {
  /** panel 视角绝对路径 */
  absPath: string;
  /** models 根内的相对路径；models 外为 null */
  rel: string | null;
  size: number;
  /** file_meta 缓存的完整 sha256；没有则 null */
  fullSha256: string | null;
  /** 宿主机视角路径。本模块不用它做判定，纯粹随候选一路带到前端：
   *  前端展示与回传都用宿主机路径（项目铁律，见 CLAUDE.md「路径宿主机视角」），
   *  panel 视角只在服务端内部流转。由构造候选的一方填——任务 12 的 scan API
   *  用 `toHost(absPath)`；本任务的测试夹具随便给个合法值即可 */
  hostPath: string;
  /** 是否被任何模型配置引用（来源 server/filesApi.ts 的 buildRefMap）。
   *  models 根外的候选恒为 false——buildRefMap 的键是根内相对路径，而
   *  gguf_file 受 ggufPathSchema 约束必须是根内相对路径，根外文件不可能被引用 */
  referenced: boolean;
}

export interface ActionsResult {
  actions: AcquireAction[];
  defaultAction: AcquireAction;
  restriction: AcquireRestriction;
}

/**
 * 动作在下拉里的固定顺序：文件级候选（actionsFor）与组级交集（mergeGroupMatch）
 * 共用这一份。此前两处各写一份且顺序不同（文件级 outside-root 给的是
 * copy 在前），同一场景下单文件组与多分片组的下拉顺序会不一致。
 * download 恒在首位——它永远是可行的兜底。默认动作另有偏好序，与展示顺序无关。
 */
const ACTION_ORDER: readonly AcquireAction[] = ["download", "move", "link", "copy"];

/** HF LFS oid（内容 sha256）校验正则；本文件是全库唯一权威定义（本地权重迁移
 *  批②任务 10 从 repo-detail-view.tsx 下沉并导出，同批删掉了另一份，原本
 *  三处同名常量降到两处——core/schemas.ts 里的 sha256Schema 语义不同（服务
 *  ModelConfig.download 字段校验），仍保持独立，不合并 */
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** basename（远端路径固定用 /，本地相对路径同样用 /） */
function basename(p: string): string {
  const slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return p.slice(slash + 1);
}

/** HF LFS oid（内容 sha256）转下载文件条目；非 LFS 或 oid 格式不合法时省略
 *  校验字段（下沉自 repo-detail-view.tsx，服务端 acquire 路由与前端展示共用
 *  同一份判定，不再各自维护一份） */
export function toDownloadFile(f: RemoteFileRef): { file: string; size: number; sha256?: string } {
  return {
    file: f.path,
    size: f.size,
    ...(f.oid !== undefined && SHA256_PATTERN.test(f.oid) ? { sha256: f.oid } : {}),
  };
}

/** 配对结果：候选 + 它与该远端文件的版本关系（规格 §4.0 两步走） */
export interface CandidateMatch {
  candidate: LocalCandidate;
  drift: DriftState;
}

/**
 * 配对：把远端文件对到本机某个候选上。
 *
 * **只看 basename 或内容哈希，不看 size**——size 属于「判定」而不是「配对」。
 * 旧实现用 `size !== remote.size` 直接 continue，于是「本机有同名文件但版本不同」
 * 在界面上完全沉默，用户看着盘上明明有文件却只能点下载（规格 §1①）。
 *
 * 同名候选可能有多个（不同目录各一份、大小各异），按 same > unknown > different
 * 取最优、同状态取先遇到的：先到先得会让「真身在别处、另有个同名但对不上的文件」
 * 时选错（迁移设计 I4 的老问题，那次是靠 size 精确匹配绕开的，配对放宽后必须
 * 在这里显式处理）。
 */
export function matchLocalCandidate(
  remote: RemoteFileRef,
  candidates: readonly LocalCandidate[],
): CandidateMatch | null {
  if (remote.size <= 0) return null;
  const wantName = basename(remote.path);
  const oidUsable = remote.oid !== undefined && SHA256_PATTERN.test(remote.oid);

  const RANK: Record<DriftState, number> = { same: 0, unknown: 1, different: 2 };
  let best: CandidateMatch | null = null;

  for (const c of candidates) {
    const pairs =
      basename(c.absPath) === wantName ||
      (oidUsable && c.fullSha256 !== null && c.fullSha256 === remote.oid);
    if (!pairs) continue;

    const drift = compareToRemote({ size: c.size, oid: c.fullSha256 }, remote);
    if (best === null || RANK[drift] < RANK[best.drift]) best = { candidate: c, drift };
    if (best.drift === "same") break; // 最优，不必再看
  }

  return best;
}

/**
 * 动作矩阵（设计 §4.3）。download 恒在首位——它永远是可行的兜底。
 *
 * 远端无 oid 时只给 download：L2 校验没有比对基准，挪一个无法证实的文件比
 * 多下一份危险得多（设计 D14）。
 *
 * 入参收窄到 {@link CandidateLocation}（LocalCandidate 是其超集）：这样服务端
 * 重验能用实测出来的位置直接复算一遍同一份矩阵，前端与服务端共用同一条规则。
 */
export function actionsFor(remote: RemoteFileRef, candidate: CandidateLocation | null): ActionsResult {
  const onlyDownload: ActionsResult = {
    actions: ["download"],
    defaultAction: "download",
    restriction: "none",
  };
  if (candidate === null) return onlyDownload;

  if (remote.oid === undefined || !SHA256_PATTERN.test(remote.oid)) {
    return { ...onlyDownload, restriction: "no-oid" };
  }

  if (!candidate.inModelsRoot) {
    // 跨挂载点：rename 抛 EXDEV、硬链接跨文件系统不成立，只剩复制系动作
    // （move 仍在其列——执行器对跨盘 move 退化成复制后删源）
    return {
      actions: ACTION_ORDER.filter((a) => a !== "link"),
      defaultAction: "copy",
      restriction: "outside-root",
    };
  }

  if (candidate.inRepoDir !== null) {
    // 移走会掏空那个档案（planFileMove 本就拒绝从档案目录移出）
    return { actions: ["download", "link"], defaultAction: "link", restriction: "in-repo" };
  }

  // 原位置是游离文件，留一份链接没意义
  return { actions: ["download", "move", "link"], defaultAction: "move", restriction: "none" };
}

/** 一个远端文件的匹配结果 */
export interface FileMatch extends ActionsResult {
  file: string;
  candidate: LocalCandidate | null;
  /** 与远端的版本关系；没有候选时为 null */
  drift: DriftState | null;
}

/** 一个量化组的匹配结果：动作按组选，判定与执行按文件（设计 §4.4） */
export interface GroupMatch extends ActionsResult {
  quant: string | null;
  kind: "model" | "mmproj";
  files: FileMatch[];
}

/**
 * 组级动作 = 组内「确实用得上本地副本」的文件可选动作的**交集**，默认动作在交集里挑：
 * move（单份、不额外占盘）> link（单份、原地不动）> copy（占额外盘但离线可行）
 * > download（永远可行的兜底）。download 恒在交集里，所以总能选出结果。
 *
 * 只用「确实用得上本地副本」的文件求交集，是因为没找到候选、或找到了但远端没
 * oid 无从确认的文件，它们的 actions 恒为 `["download"]`——把它们也算进交集会把
 * 整组拖成「只能下载」：3 片里缺 1 片就要把已经在盘上的 2 片重新下载几十 GB，
 * 正背离本里程碑「同一份权重文件全机只下载一次」的目标。设计 §4.4：「组的默认
 * 动作取组内**已有文件**的位置推出；组内没有对应本地文件的分片，该文件走下载」，
 * 两者同批执行——那些被排除的文件依然在 `files` 里、依然会走 download，只是不
 * 参与「组里还能统一做什么」的推导。
 *
 * 全部文件都用不上本地副本时，交集退回全体（结果自然是 `["download"]`）。
 */
export function mergeGroupMatch(
  quant: string | null,
  kind: "model" | "mmproj",
  files: FileMatch[],
): GroupMatch {
  const usable = files.filter((f) => f.actions.some((a) => a !== "download"));
  const basis = usable.length > 0 ? usable : files;
  const actions = ACTION_ORDER.filter((a) => basis.every((f) => f.actions.includes(a)));

  const preference: AcquireAction[] = ["move", "link", "copy", "download"];
  const defaultAction = preference.find((a) => actions.includes(a)) ?? "download";

  // 组级 restriction 从**全部** files 取第一个非 none 的，不是从 basis 取：
  // 被排除出 basis 的文件恰恰是最需要向用户解释的那些（「这片没有校验值，只能
  // 下载」），从 basis 取会把这条信息丢掉
  const restriction = files.find((f) => f.restriction !== "none")?.restriction ?? "none";

  return { quant, kind, files, actions, defaultAction, restriction };
}
