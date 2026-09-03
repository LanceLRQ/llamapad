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
  }));
}

/**
 * 把队列推送折算到组：组内多个文件各有一个任务，组的阶段取最"未完成"的那个——
 * 只要还有一片在跑，整组就是 executing；进度按「已到达推送的字节比例 × 已到达
 * 文件数占比」折算（见下方 ratio 的注释——不能只看已到达那部分的字节比例，否则
 * 1 片完成、其余没消息时会显示 100%）。
 */
export function applyTaskUpdate(rows: readonly AcquireRow[], updates: readonly TaskUpdate[]): AcquireRow[] {
  const byFile = new Map(updates.map((u) => [u.file, u]));
  return rows.map((row) => {
    const mine = row.files.map((f) => byFile.get(f.file)).filter((u): u is TaskUpdate => u !== undefined);
    if (mine.length === 0) return row;

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

    const done = mine.length === row.files.length && mine.every((u) => u.status === "completed");
    if (done) return { ...row, phase: "done", progress: 1, error: null };

    const downloaded = mine.reduce((sum, u) => sum + u.downloadedBytes, 0);
    const total = mine.reduce((sum, u) => sum + u.totalBytes, 0);
    // 按「已到达推送的文件数 / 组内文件数」折算：没到达推送的分片其字节数在这一层
    // 拿不到（FileMatch 只带候选的 size，要下载的那些没有大小信息），直接用已到达
    // 部分的比例当整组进度会虚高——1 片完成、2 片没消息时会显示 100%。分片通常
    // 是均匀切的，按文件数折算的偏差远小于这个虚高
    const ratio = mine.length / row.files.length;
    return { ...row, phase: "executing", progress: total > 0 ? (downloaded / total) * ratio : null };
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
 * 用户勾选的行 → 深度扫描（`POST /scan`）产出的 `GroupMatch[]`（复核修复，
 * 任务 15 从组件下沉）。两者身份对齐只看 (quant, kind)，不看下标——档案页
 * 常规扫描（`GET /files`）与深度扫描各自独立取数，分组顺序未必一致。
 * `picked` 只取结构性子集，不逼调用方传完整 `RepoRow`。
 */
export function matchScannedGroups(
  picked: readonly { quant: string | null; kind: "model" | "mmproj" }[],
  groups: readonly GroupMatch[],
): GroupMatch[] {
  return groups.filter((g) => picked.some((r) => r.quant === g.quant && r.kind === g.kind));
}

/** POST /acquire 的单条 items（服务端 itemSchema 逐字段对齐） */
export interface AcquireSubmitItem {
  file: string;
  action: AcquireAction;
  /** 宿主机视角路径；action !== "download" 时必填（服务端 toPanel 换算后重验） */
  sourceHostPath?: string;
}

/**
 * acquireRows → 提交请求体的 items（复核修复，任务 15 从组件下沉）。
 *
 * 只提交 `isRowEditable` 的行——done 的行已经成功，混进同一次提交只会把
 * 它重新入队一遍（重复搬运/重复下载）；executing 理论上不会出现在这里
 * （`canSubmit` 已经在按钮层挡住），这里再滤一次纯属防御，不依赖调用方
 * 一定守规矩。
 *
 * 组内每个文件的动作单独判定：组级动作（`row.action`）只施加到**组内确实
 * 有本地候选**的文件（`f.candidate !== null`）；组内没有候选的那些文件强制
 * 降级为 `download`（设计 §4.4「移动 2 片 + 下载 1 片同属一个 batch」）。
 * 这个降级必须在提交前做——服务端见到 `action ≠ download` 却不带
 * `sourceHostPath` 会直接 400 `SOURCE_REQUIRED`，那是防篡改的正确防御，
 * 不该为混合组放宽。
 */
export function buildAcquireSubmitItems(rows: readonly AcquireRow[]): AcquireSubmitItem[] {
  return rows
    .filter((row) => isRowEditable(row))
    .flatMap((row) =>
      row.files.map((f): AcquireSubmitItem => {
        const action = row.action === "download" || f.candidate === null ? "download" : row.action;
        return {
          file: f.file,
          action,
          ...(action === "download" ? {} : { sourceHostPath: f.candidate!.hostPath }),
        };
      }),
    );
}
