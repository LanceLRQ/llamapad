import { shardGroup } from "@/core/files";
import type { AcquireAction, AcquireRestriction, FileMatch, GroupMatch } from "./acquire-match";

/**
 * 确认弹层的行状态机（设计 §9.1）
 *
 * 弹层里发生的事有三段：用户选动作（idle）→ 提交后服务端校验与执行（executing）→
 * 终态（done / failed）。进度直接取队列任务的 downloadedBytes / totalBytes——
 * 执行器已经把「校验 + 复制」折算成单调递增的总工作量（见 localAcquire.totalWorkOf），
 * 前端不需要知道现在是哪一阶段。
 */
export type AcquireRowPhase = "idle" | "executing" | "done" | "failed";

export interface AcquireRow {
  quant: string | null;
  kind: "model" | "mmproj";
  /** 组内各文件的匹配结果——动作按组选，提交时逐个文件发给 acquire */
  files: readonly FileMatch[];
  action: AcquireAction;
  actions: readonly AcquireAction[];
  restriction: AcquireRestriction;
  phase: AcquireRowPhase;
  progress: number | null;
  error: string | null;
  /** 失败后是否可以一键改为下载（校验不过的行都可以） */
  canFallbackToDownload: boolean;
  /** 这一行是用户手动关联的（规格 §7）：动作由用户在弹层里挑定，提交时带
   *  manual 让服务端跳过内容校验。扫描结果构造出来的行一律 false，
   *  手动关联的行由手动关联弹层单独构造 */
  manual: boolean;
}

/** 队列任务的一次状态推送（来自已有的 downloads SSE），按远端文件名对齐到组 */
export interface TaskUpdate {
  file: string;
  status: string;
  downloadedBytes: number;
  totalBytes: number;
  error?: string;
}

export function buildRows(groups: readonly GroupMatch[]): AcquireRow[] {
  return groups.map((g) => ({
    quant: g.quant,
    kind: g.kind,
    files: g.files,
    action: g.defaultAction,
    actions: g.actions,
    restriction: g.restriction,
    phase: "idle",
    progress: null,
    error: null,
    canFallbackToDownload: false,
    manual: false,
  }));
}

/**
 * 把队列推送折算到组：组内多个文件各有一个任务，组的阶段取最"未完成"的那个——
 * 只要还有一片在跑，整组就是 executing；进度按「已到达推送的字节比例 × 已到达
 * 文件数占比」折算（见下方注释——不能只看已到达那部分的字节比例，否则
 * 1 片完成、其余没消息时会显示 100%）。
 *
 * `skippedFiles` 是入队时因「目标已存在且大小匹配」而**压根没建任务**的文件
 * （`POST /acquire` 响应里的 skipped）。这些文件永远不会有任务推送到达，不把
 * 它们视同已完成，「整组是否完成」的判定对「3 分片已存在 2 片」这类组就永远
 * 不成立：行卡死在 executing，弹层又被执行中守卫拦住关不掉，只能刷新页面。
 * 分片模型下载中断后重进档案页就是这个形态，与用户选了哪个动作无关（选
 * 「下载」同样被跳过）。
 */
export function applyTaskUpdate(
  rows: readonly AcquireRow[],
  updates: readonly TaskUpdate[],
  skippedFiles: readonly string[] = [],
): AcquireRow[] {
  const byFile = new Map(updates.map((u) => [u.file, u]));
  const skipped = new Set(skippedFiles);
  return rows.map((row) => {
    const mine = row.files.map((f) => byFile.get(f.file)).filter((u): u is TaskUpdate => u !== undefined);
    // 被跳过的文件不会重复出现在 updates 里（它没有任务行），两个计数可以直接相加
    const skippedCount = row.files.filter((f) => skipped.has(f.file)).length;
    if (mine.length === 0 && skippedCount === 0) return row;

    const failed = mine.find((u) => u.status === "failed" || u.status === "cancelled");
    if (failed) {
      return {
        ...row,
        phase: "failed",
        error: failed.error ?? null,
        // 本地获取失败一律可退回下载——下载是永远可行的兜底
        canFallbackToDownload: row.action !== "download",
      };
    }

    const done =
      mine.length + skippedCount === row.files.length && mine.every((u) => u.status === "completed");
    if (done) return { ...row, phase: "done", progress: 1, error: null };

    const downloaded = mine.reduce((sum, u) => sum + u.downloadedBytes, 0);
    const total = mine.reduce((sum, u) => sum + u.totalBytes, 0);
    // 按文件数折算：没到达推送的分片其字节数在这一层拿不到（FileMatch 只带候选的
    // size，要下载的那些没有大小信息），直接用已到达部分的比例当整组进度会虚高
    // ——1 片完成、2 片没消息时会显示 100%。分片通常是均匀切的，按文件数折算的
    // 偏差远小于这个虚高。被跳过的文件按「整片已完成」计入分子
    const byteRatio = total > 0 ? downloaded / total : null;
    const progress =
      byteRatio === null
        ? skippedCount > 0
          ? skippedCount / row.files.length
          : null
        : (skippedCount + byteRatio * mine.length) / row.files.length;
    return { ...row, phase: "executing", progress };
  });
}

/**
 * 一行是否还能改动作/参与提交：只有 idle（还没提交过）和 failed（可以改了动作
 * 重试）算数——executing 和 done 都已经走上了不可撤回的执行路径。`canSubmit` 与
 * 弹层组件里「Select 能不能交互」共用这同一条判据，两处都调这里，不各自复刻一份，
 * 免得日后口径改了只改到一处、静默漂移
 */
export function isRowEditable(row: Pick<AcquireRow, "phase">): boolean {
  return row.phase === "idle" || row.phase === "failed";
}

/**
 * 「确认执行」是否可点（复核修复：done 不再拖累其余行）。
 *
 * 判据两条都要满足：① 没有行在 executing（防止同一批还没跑完就再交一遍，
 * 服务端对同一目标路径的重复入队会拒绝，但没必要让用户点了才知道）；
 * ② 至少有一行是 idle 或 failed（真有活要干——全 done 时没什么好提交的，
 * 交了也是空转）。
 *
 * 旧版本用 `rows.every(isRowEditable)`：只要一行到达 done，整批就永久禁用，
 * 用户在另一行点「改为下载」也提交不了。这违背设计 §12 状态机画的「失败 →
 * 改为下载」转移——§4.4「移动 2 片 + 下载 1 片同属一个 batch」说明部分成功
 * 部分失败是设计内的常见形态，不是要拦住的边角。`onAcquireSubmit`（调用方）
 * 必须只提交 isRowEditable 的行，不能对本函数放行的整个 rows 数组不加过滤
 * 地重新入队——否则已经 done 的行会被重复搬运/重复下载，见
 * `buildAcquireSubmitItems`。
 */
export function canSubmit(rows: readonly AcquireRow[]): boolean {
  return !rows.some((row) => row.phase === "executing") && rows.some(isRowEditable);
}

/**
 * 弹层是否有正在执行的行——用来拦截用户中途关闭确认框（右上角 X / Esc）。
 * 半途 kill 掉一个正在 move/link/copy 的任务，磁盘上会留下不上不下的半成品，
 * 比等它跑完更麻烦。与 canSubmit 判据字面相近但立场相反：canSubmit 问「是否
 * 全部可编辑」，这里问「是否有任何一行已经不可逆地在跑」，不能共用同一个判据。
 */
export function hasExecutingRow(rows: readonly AcquireRow[]): boolean {
  return rows.some((row) => row.phase === "executing");
}

/**
 * 组身份：弹层的 React key、以及「改这一组的动作」时定位用的标识。
 *
 * 用文件名列表而不是 quant——quant 可能是 null（未识别），同一档案里也可能有
 * 两组都识别不出量化，那样 key 会撞。这与档案页 `QuantCard` 的 key 表达式
 * （`${row.kind}:${row.files.join(",")}`）是同一套口径，两处保持一致。
 */
export function groupKey(row: Pick<AcquireRow, "kind" | "files">): string {
  return `${row.kind}:${row.files.map((f) => f.file).join(",")}`;
}

/**
 * 弹层里一行的主身份文案：组内第一个文件的**仓库内完整路径**（分片组剥掉
 * `-0000N-of-0000M` 只留共同前缀）。
 *
 * 不用量化标签当主身份，与档案页 `QuantCard` 的 `fileLabel` 同一条理由：量化
 * 是从文件名启发式认出来的，同一个 (quant, kind) 下完全可以有多组（真机的
 * `Qwen3.8-27B-Q4_0.gguf` 与 `MTP/mtp-Qwen3.8-27B-Q4_0.gguf` 就是），只显示
 * "Q4_0" 时用户无从分辨自己选的是哪一个。这里比 `fileLabel` 多保留目录前缀
 * ——弹层是最后一道确认，目录正是区分这两组的那个信息。
 */
export function rowLabel(row: Pick<AcquireRow, "files">): string {
  const first = row.files[0]?.file;
  if (first === undefined) return "";
  return shardGroup(first)?.prefix ?? first;
}

/** 仓库内相对路径的 basename（HF 路径固定用 "/" 分隔） */
function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** 组身份序列化：kind + 组内文件名列表（JSON 键，杜绝分隔符与文件名碰撞） */
function identityKey(kind: string, names: readonly string[]): string {
  return JSON.stringify([kind, names]);
}

/**
 * 用户勾选的行 → 深度扫描（`POST /scan`）产出的 `GroupMatch[]`（复核修复，
 * 任务 15 从组件下沉）。两侧独立取数、分组顺序未必一致（两次 `getRemoteGroups`
 * 之间缓存可能过期重取），所以按内容匹配而不是按下标。
 *
 * 身份是 **kind + 组内文件名列表**，不是 (quant, kind)——后者根本不是身份：
 * `core/quant.ts` 的分组键是 `[kind, quant, shardKey]`，同一个 (quant, kind)
 * 下完全可以有多组。真机踩到的就是这个：`unsloth/Qwen3.8-27B-GGUF` 里
 * `Qwen3.8-27B-Q4_0.gguf` 与 `MTP/mtp-Qwen3.8-27B-Q4_0.gguf` 都是
 * (Q4_0, model)，用户只勾了 MTP 那一组，弹层却把两组都列了出来——两行还都
 * 只显示 "Q4_0"，用户无从分辨哪个是自己选的。quant 不进身份：它是
 * `detectQuant(basename)` 从文件名推出来的派生标签，文件名列表一致 ⇒ quant
 * 必然一致，带上它只是冗余。
 *
 * 两侧的文件名口径不同——`GroupMatch.files[].file` 是仓库内**完整路径**
 * （scan 路由填的 `rf.path`），而 `RepoRow.files` 在 `mergeRepoRows` 里已按
 * basename 收窄。所以两个键都试：调用方传完整路径（用
 * `buildGroupingRows` 回填过目录的那份行）时按完整路径精确匹配，传 basename
 * 时退回按 basename 匹配。两条路不会互相误命中——picked 侧带目录时它的键里
 * 就有目录，永远不会等于某个组的 basename 键。
 */
export function matchScannedGroups(
  picked: readonly { kind: "model" | "mmproj"; files: readonly string[] }[],
  groups: readonly GroupMatch[],
): GroupMatch[] {
  const wanted = new Set(picked.map((r) => identityKey(r.kind, r.files)));
  return groups.filter((g) => {
    const paths = g.files.map((f) => f.file);
    return (
      wanted.has(identityKey(g.kind, paths)) || wanted.has(identityKey(g.kind, paths.map(basename)))
    );
  });
}

/** POST /acquire 的单条 items（服务端 itemSchema 逐字段对齐） */
export interface AcquireSubmitItem {
  file: string;
  action: AcquireAction;
  /** 宿主机视角路径；action !== "download" 时必填（服务端 toPanel 换算后重验） */
  sourceHostPath?: string;
  /** 手动关联（规格 §7）。**只在需要时才带这个键**：服务端的 itemSchema 是
   *  strictObject，且该字段是 z.literal(true).optional()，带上 false 会被整体拒绝 */
  manual?: true;
}

/**
 * acquireRows → 提交请求体的 items（复核修复，任务 15 从组件下沉）。
 *
 * 只提交 `isRowEditable` 的行——done 的行已经成功，混进同一次提交只会把
 * 它重新入队一遍（重复搬运/重复下载）；executing 理论上不会出现在这里
 * （`canSubmit` 已经在按钮层挡住），这里再滤一次纯属防御，不依赖调用方
 * 一定守规矩。
 *
 * 组内每个文件的动作单独判定：组级动作（`row.action`）只施加到**自己也支持
 * 这个动作**的文件（`f.actions.includes(row.action)`），其余强制降级为
 * `download`（设计 §4.4「移动 2 片 + 下载 1 片同属一个 batch」）。
 *
 * 判据是「支不支持」而不是「有没有候选」：**候选存在但远端没有 oid** 时
 * `actionsFor` 给的是 `actions: ["download"], restriction: "no-oid"`，而
 * `candidate` 非 null。`mergeGroupMatch` 会把这种文件排除出求交集的 basis，
 * 于是组级动作完全可能是 `link`——按「有没有候选」判就会给这个文件发
 * `link` + `sourceHostPath`，服务端 L1 重验发现 `rf.oid === undefined` 直接
 * 400 `MISMATCH`，整批一条都进不去，错误文案还指向完全错误的原因。
 *
 * 这个降级必须在提交前做——服务端见到 `action ≠ download` 却不带
 * `sourceHostPath` 会直接 400 `SOURCE_REQUIRED`，那是防篡改的正确防御，
 * 不该为混合组放宽。
 */
export function buildAcquireSubmitItems(rows: readonly AcquireRow[]): AcquireSubmitItem[] {
  return rows
    .filter((row) => isRowEditable(row))
    .flatMap((row) =>
      row.files.map((f): AcquireSubmitItem => {
        // 手动关联行只看组级 actions：这类行的 f.actions 恒是 ["download"]
        // （手动关联的典型处境就是 drift 为 different，actionsFor 只给下载），
        // 把文件级判据一起要求会把用户刚挑定的动作原地降级掉，逃生口失效。
        // 前端仍不许自造动作——组级 actions 这道判据对两类行一视同仁。
        const supported = row.manual
          ? row.actions.includes(row.action)
          : row.actions.includes(row.action) && f.actions.includes(row.action);
        const action = supported ? row.action : "download";
        return {
          file: f.file,
          action,
          // action 非 download ⇒ f.actions 含该动作 ⇒ actionsFor 见到的是非空
          // 候选（candidate 为 null 时它只返回 ["download"]），断言成立。
          // 手动关联行走的是组级判据，候选由弹层挑定，同样非空
          ...(action === "download" ? {} : { sourceHostPath: f.candidate!.hostPath }),
          ...(row.manual && action !== "download" ? { manual: true as const } : {}),
        };
      }),
    );
}
