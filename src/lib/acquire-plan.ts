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
 * 有任何一行不是 idle 或 failed 就不许再提交，防重复入队——包括 executing（正在
 * 跑）和 done（已完成的行不该跟着同批再提交一次）
 */
export function canSubmit(rows: readonly AcquireRow[]): boolean {
  return rows.length > 0 && rows.every(isRowEditable);
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
