import { METRIC_IDS } from "@/server/metrics/ids";
import type { LatestSample } from "@/server/metrics/latest";

/**
 * 状态栏纯逻辑层（M16 T1）：把可测的格式化 / 派生判定从组件里搬出来。
 * vitest 配置是 environment: "node"，没有 jsdom，组件渲染测试跑不动——
 * 可测逻辑一律下沉到这里配 .test.ts（对齐 lib/format.ts、lib/connection-store.ts
 * 的既有做法）。GPU/磁盘两个格式化器只做展示整形，不发请求；下载条目的派生
 * 是从旧顶栏下载徽标原样抽出，行为逐字不变（抽取是重构，不是改行为）。
 */

/** 状态栏条目的共用外壳类：h-[22px] + rounded-sm + font-mono 11.5px。
 * gap 由调用方按内容密度自定（图标+文字用 1.5，纯文字用 1），不内置在这里——
 * 四个引用点（downloads-badge / theme-toggle / locale-toggle / status-bar-client）
 * 曾经各写一份几乎相同的类名，改一处漏三处，收敛成这一个导出常量。 */
export const STATUS_BAR_ITEM_CLASS =
  "flex h-[22px] items-center rounded-sm px-[9px] font-mono text-[11.5px] whitespace-nowrap";

/**
 * GPU 一行展示（均取自 /api/v1/gpu/stats）：
 * - strong：利用率，加粗 --foreground 的强调段；util/mem 都缺时退化成单个 "—"
 *   （两个独立的破折号并排是噪音，参见 status-bar-client 的渲染）
 * - dim：显存 used/total，62% 透明的弱化段；仅当 util/mem 都缺时才是 null
 *   （不渲染），只缺其中一项时该项仍各自退化为 "—" 展示
 */
export interface GpuReadout {
  strong: string;
  dim: string | null;
}

export function formatGpuReadout(
  samples: { [metric: string]: LatestSample } | null,
  totals: { memUsedMib: number; memTotalMib: number } | null,
): GpuReadout {
  const utilSample = samples?.[METRIC_IDS.gpuUtilPercent];
  const utilKnown = utilSample !== undefined;
  const memKnown = totals !== null;
  if (!utilKnown && !memKnown) return { strong: "—", dim: null };

  const util = utilKnown ? `${Math.round(utilSample.value)}%` : "—";
  // 显存单位用 GiB（1024³ 进制的准确写法）：监控页 metric-cards.tsx 的同一个数
  // 也标 GiB，两处不一致会让用户以为是两个不同的数
  const mem = memKnown
    ? `${(totals.memUsedMib / 1024).toFixed(1)} / ${(totals.memTotalMib / 1024).toFixed(1)} GiB`
    : "—";
  return { strong: util, dim: mem };
}

/**
 * 磁盘已用/总量展示（宿主机 host/stats，与概览页 models 目录扫描求和是两个
 * 不同的数，不能互相替代）：
 * - strong：已用（= 总量 − 剩余），加粗 --foreground
 * - dim：总量，62% 透明；用/总只要缺一个就整体退化为 "—"（与 GPU 不同，
 *   这两个数本就是同一份 statfs 读数拆出来的，没有"只缺一半"的场景）
 * 两个数都按 GB（1024³）取整——这里刻意跟 GPU 显存不同单位（GiB vs GB）：
 * 磁盘沿用 lib/format.ts 的 formatSize 惯例（概览页磁盘卡同款标法），每个数
 * 跟它在别处的样子对齐，比同一行内两个单位整齐更重要。
 */
export interface DiskReadout {
  strong: string;
  dim: string | null;
}

export function formatDiskReadout(freeBytes: number | null, totalBytes: number | null): DiskReadout {
  if (freeBytes === null || totalBytes === null) return { strong: "—", dim: null };
  const usedGb = Math.round((totalBytes - freeBytes) / 1024 ** 3);
  const totalGb = Math.round(totalBytes / 1024 ** 3);
  return { strong: `${usedGb}`, dim: `/ ${totalGb} GB` };
}

/** 运行模型 chip 的端口后缀：":18080"；未知端口（模型行已删）不占位 */
export function formatPort(hostPort: number | null): string {
  return hostPort !== null ? `:${hostPort}` : "";
}

// ---- 下载条目派生（从旧顶栏下载徽标原样抽出，行为逐字不变）----

export interface DownloadTaskSnapshot {
  id: number;
  model: string;
  status: "pending" | "downloading" | "paused" | "completed" | "failed" | "cancelled";
  downloadedBytes: number;
  expectedSize: number | null;
  updatedAt: string;
}

/** 派生所需的文案（由组件把 i18n 文案传进来，本文件不依赖 next-intl） */
export interface DownloadStateLabels {
  waiting: string;
  failed: string;
  indeterminate: string;
}

export interface DerivedDownloadState {
  /** 条目文案：百分比 / "下载中" / 失败文案，可能带 "+N" 排队后缀 */
  label: string;
  /** HTML title 属性文案：下载中取该任务模型名，否则退回等待文案（只做悬浮
   * 提示，不内联展示——内联展示另见 modelName，避免同一段文案渲染两遍） */
  title: string;
  /** 内联展示的模型名：仅下载中有值（该任务模型名），其余情况为 null——
   * 组件据此判断是否渲染"模型名淡色"那一段，null 时不渲染 */
  modelName: string | null;
  /** document.title 目标值（下载中含百分比与模型名，否则恢复 BASE_TITLE） */
  docTitle: string;
  failed: boolean;
}

/** document.title 空闲态：无未完成任务时恢复的标题 */
export const BASE_TITLE = "llamapad";

/** 失败信号新鲜度窗口：窗口外的 failed 不再点红徽标（任务仍留列表供重试） */
const FRESH_FAILED_MS = 5 * 60_000;

/**
 * 从任务快照派生下载条目的展示状态：无进行中/排队/暂停/新鲜失败任务时
 * 返回 null（组件据此不渲染条目，并把 document.title 恢复为 BASE_TITLE）。
 */
export function deriveDownloadState(
  tasks: DownloadTaskSnapshot[],
  now: number,
  labels: DownloadStateLabels,
): DerivedDownloadState | null {
  const downloading = tasks.find((task) => task.status === "downloading");
  const queued = tasks.filter((task) => task.status === "pending").length;
  const paused = tasks.some((task) => task.status === "paused");
  const freshFailed = tasks.find(
    (task) => task.status === "failed" && now - Date.parse(task.updatedAt) < FRESH_FAILED_MS,
  );
  const active = downloading !== undefined || queued > 0 || paused || freshFailed !== undefined;
  if (!active) return null;

  let label = labels.waiting;
  if (freshFailed !== undefined) label = labels.failed;

  let docTitle = BASE_TITLE;
  if (downloading !== undefined) {
    const pct =
      downloading.expectedSize !== null && downloading.expectedSize > 0
        ? Math.min(100, Math.round((downloading.downloadedBytes / downloading.expectedSize) * 100))
        : null;
    label = pct !== null ? `${pct}%` : labels.indeterminate;
    docTitle = `${pct !== null ? `${pct}% · ` : ""}${downloading.model} — ${BASE_TITLE}`;
  }
  if (queued > 0 && freshFailed === undefined) label = `${label} +${queued}`;

  return {
    label,
    title: downloading !== undefined ? downloading.model : labels.waiting,
    modelName: downloading !== undefined ? downloading.model : null,
    docTitle,
    failed: freshFailed !== undefined,
  };
}
