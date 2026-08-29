/**
 * 下载页二级栏纯逻辑层（M16 T7）：任务生命周期六格——视图解析、四块显隐、
 * 队列表按视图过滤、二级栏计数与 meta 素材。对齐 lib/files-view.ts、
 * lib/settings-tabs.ts 的既有做法（vitest 是 environment: "node"，
 * 组件渲染测不了，可测判定一律下沉到这里配 .test.ts）。
 *
 * 与设置页 / 文件页的二级栏不同：这一页的计数与 meta（队列速度、各状态任务数）
 * 是每秒变的实时数据，不能在 server 侧算，所以这份逻辑由 client 组件消费
 * （见 downloads-view.tsx），而不是走 page.tsx 装配。
 */

/**
 * 二级栏六格。四个状态格的 key 直接用 DownloadTaskEntry["status"] 的字面量
 * （而非设计稿脚本里图省事的缩写 dl/pend/pause/fail），这样过滤能直接写成
 * `task.status === view`，省掉一张映射表，`?view=` 深链也自解释。
 *
 * 没有 completed / cancelled：completed 归档进 history、cancelled 是有意
 * 丢弃（见 downloads-view.tsx 顶部注释），两者都不进任务列表——二级栏是
 * 任务生命周期，不是 status 全集。
 */
export type DownloadsView = "queue" | "downloading" | "pending" | "paused" | "failed" | "history";

export const DOWNLOADS_VIEWS: readonly DownloadsView[] = [
  "queue",
  "downloading",
  "pending",
  "paused",
  "failed",
  "history",
];

export const DEFAULT_DOWNLOADS_VIEW: DownloadsView = "queue";

/** 非法/缺省一律落回 queue，与 resolveSettingsTab / resolveFilesView 同一兜底思路 */
export function resolveDownloadsView(raw: string | undefined): DownloadsView {
  return raw !== undefined && (DOWNLOADS_VIEWS as readonly string[]).includes(raw)
    ? (raw as DownloadsView)
    : DEFAULT_DOWNLOADS_VIEW;
}

/** 四块内容的显隐（照抄设计稿 select() 的规则，理由逐条见下） */
export interface DownloadsBlocks {
  /** 队列停摆告警 */
  warn: boolean;
  /** 当前任务大卡 */
  current: boolean;
  /** 队列表 */
  queue: boolean;
  /** 历史卡 */
  history: boolean;
}

export function downloadsBlocks(view: DownloadsView): DownloadsBlocks {
  return {
    // 停摆是失败堆积的后果，「已失败」正是去处理它的地方；别的切片里它是噪音
    warn: view === "queue" || view === "failed",
    // 大卡本身就是那条 downloading 记录，只在含它的视图出现
    current: view === "queue" || view === "downloading",
    // 「进行中」视图下队列表是空的（那条已由大卡承担），整张表收起而不是留个空表头
    queue: view === "queue" || view === "pending" || view === "paused" || view === "failed",
    history: view === "history",
  };
}

/** 队列表在各视图下要显示哪些行：queue 视图给全部，状态视图只给同状态的 */
export function queueRowsForView<T extends { status: string }>(
  view: DownloadsView,
  rows: readonly T[],
): T[] {
  if (view === "queue") return [...rows];
  if (view === "pending" || view === "paused" || view === "failed") {
    return rows.filter((row) => row.status === view);
  }
  // downloading / history：downloadsBlocks().queue 本就是 false（表整张收起），
  // 给空数组而不是全部，调用方即使漏判 blocks.queue 也不会多渲染行
  return [];
}

/**
 * computeDownloadsNavCounts 只用到这四个字段；lib 不依赖组件的 DTO——
 * 组件那边的 DownloadTaskEntry 结构上兼容即可，不需要在这里 import 它。
 */
export interface DownloadTaskLike {
  id: number;
  status: string;
  expectedSize: number | null;
  downloadedBytes: number;
}

/** 二级栏一格的计数与 meta 素材（不含文案，文案在组件里走 i18n） */
export interface DownloadsNavCounts {
  queue: { count: number; speedBytesPerSec: number; hasActive: boolean };
  downloading: { count: number; bytes: number };
  pending: { count: number; bytes: number };
  paused: { count: number; downloadedBytes: number; totalBytes: number };
  failed: { count: number; bytes: number };
  history: { count: number; bytes: number };
}

export function computeDownloadsNavCounts(
  tasks: readonly DownloadTaskLike[],
  history: readonly { totalBytes: number }[],
  speeds: Readonly<Record<number, number>>,
): DownloadsNavCounts {
  let queueCount = 0;
  let downloadingCount = 0;
  let downloadingBytes = 0;
  let downloadingSpeed = 0;
  let pendingCount = 0;
  let pendingBytes = 0;
  let pausedCount = 0;
  let pausedDownloaded = 0;
  let pausedTotal = 0;
  let failedCount = 0;
  let failedBytes = 0;

  for (const task of tasks) {
    // queue.count 与现有 unfinished 同义：未完成 = 不在终态里
    if (task.status !== "completed" && task.status !== "cancelled") queueCount++;

    switch (task.status) {
      case "downloading":
        downloadingCount++;
        // expectedSize 为 null（未知大小）跳过，不能当 0 计入——会让总量
        // 偏小且不可察觉
        if (task.expectedSize !== null) downloadingBytes += task.expectedSize;
        downloadingSpeed += speeds[task.id] ?? 0;
        break;
      case "pending":
        pendingCount++;
        if (task.expectedSize !== null) pendingBytes += task.expectedSize;
        break;
      case "paused":
        pausedCount++;
        // downloadedBytes 不可为 null，不受 expectedSize 是否已知影响
        pausedDownloaded += task.downloadedBytes;
        if (task.expectedSize !== null) pausedTotal += task.expectedSize;
        break;
      case "failed":
        failedCount++;
        if (task.expectedSize !== null) failedBytes += task.expectedSize;
        break;
      default:
        // pending/downloading/paused/failed 之外（completed/cancelled）
        // 不进任何状态格，只已经计入/未计入 queueCount
        break;
    }
  }

  return {
    queue: { count: queueCount, speedBytesPerSec: downloadingSpeed, hasActive: downloadingCount > 0 },
    downloading: { count: downloadingCount, bytes: downloadingBytes },
    pending: { count: pendingCount, bytes: pendingBytes },
    paused: { count: pausedCount, downloadedBytes: pausedDownloaded, totalBytes: pausedTotal },
    failed: { count: failedCount, bytes: failedBytes },
    history: {
      count: history.length,
      bytes: history.reduce((sum, entry) => sum + entry.totalBytes, 0),
    },
  };
}
