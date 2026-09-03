/**
 * 本地获取的匹配与动作判定（设计 §4.2 / §4.3）
 *
 * 全部零 IO：size 来自 scanTree 已有的 stat，fullSha256 来自 file_meta 缓存。
 * 真正读盘的 L2 校验发生在用户确认之后，由 server/download/localAcquire.ts 承担。
 */

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

/** 本地扫描出的一个候选文件 */
export interface LocalCandidate {
  /** panel 视角绝对路径 */
  absPath: string;
  /** models 根内的相对路径；models 外为 null */
  rel: string | null;
  size: number;
  /** file_meta 缓存的完整 sha256；没有则 null */
  fullSha256: string | null;
  /** 落在哪个档案的 targetDir 内；不在任何档案内为 null */
  inRepoDir: string | null;
  inModelsRoot: boolean;
  /** 宿主机视角路径。本模块不用它做判定，纯粹随候选一路带到前端：
   *  前端展示与回传都用宿主机路径（项目铁律，见 CLAUDE.md「路径宿主机视角」），
   *  panel 视角只在服务端内部流转。由构造候选的一方填——任务 12 的 scan API
   *  用 `toHost(absPath)`；本任务的测试夹具随便给个合法值即可 */
  hostPath: string;
}

export interface ActionsResult {
  actions: AcquireAction[];
  defaultAction: AcquireAction;
  restriction: AcquireRestriction;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** basename（远端路径固定用 /，本地相对路径同样用 /） */
function basename(p: string): string {
  const slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return p.slice(slash + 1);
}

/**
 * L1 快筛：size 必须精确相等，且满足下列之一——
 * - basename 相同（最常见：同一份文件原样放在别处）
 * - 本地已缓存的 full_sha256 等于远端 oid（跨仓库改过名的同一文件，唯一可靠判据）
 *
 * 远端 size 不是正数时一律不匹配：宁可显示「未下载」，也不能凭一个名字就给出
 * 「把某个不知道是什么的文件挪进来」的按钮（沿用 repo-files-view.ts 的 I4 裁定）。
 */
export function matchLocalCandidate(
  remote: RemoteFileRef,
  candidates: readonly LocalCandidate[],
): LocalCandidate | null {
  if (remote.size <= 0) return null;
  const wantName = basename(remote.path);
  const oidUsable = remote.oid !== undefined && SHA256_PATTERN.test(remote.oid);

  for (const c of candidates) {
    if (c.size !== remote.size) continue;
    if (basename(c.absPath) === wantName) return c;
    if (oidUsable && c.fullSha256 !== null && c.fullSha256 === remote.oid) return c;
  }
  return null;
}

/**
 * 动作矩阵（设计 §4.3）。download 恒在首位——它永远是可行的兜底。
 *
 * 远端无 oid 时只给 download：L2 校验没有比对基准，挪一个无法证实的文件比
 * 多下一份危险得多（设计 D14）。
 */
export function actionsFor(remote: RemoteFileRef, candidate: LocalCandidate | null): ActionsResult {
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
    return { actions: ["download", "copy", "move"], defaultAction: "copy", restriction: "outside-root" };
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
  const order: AcquireAction[] = ["download", "move", "link", "copy"];
  const actions = order.filter((a) => basis.every((f) => f.actions.includes(a)));

  const preference: AcquireAction[] = ["move", "link", "copy", "download"];
  const defaultAction = preference.find((a) => actions.includes(a)) ?? "download";

  // 组级 restriction 从**全部** files 取第一个非 none 的，不是从 basis 取：
  // 被排除出 basis 的文件恰恰是最需要向用户解释的那些（「这片没有校验值，只能
  // 下载」），从 basis 取会把这条信息丢掉
  const restriction = files.find((f) => f.restriction !== "none")?.restriction ?? "none";

  return { quant, kind, files, actions, defaultAction, restriction };
}
