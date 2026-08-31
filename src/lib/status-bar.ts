import { METRIC_IDS } from "@/server/metrics/ids";
import type { LatestSample } from "@/server/metrics/latest";

/**
 * 状态栏纯逻辑层（M16 T1；条形计量改造新增 CPU/内存/GPU/磁盘四个 gauge
 * 格式化器 + 色阶判定）：把可测的格式化 / 派生判定从组件里搬出来。
 * vitest 配置是 environment: "node"，没有 jsdom，组件渲染测试跑不动——
 * 可测逻辑一律下沉到这里配 .test.ts（对齐 lib/format.ts、lib/connection-store.ts
 * 的既有做法）。四个 gauge 格式化器只做展示整形，不发请求；下载条目的派生
 * 是从旧顶栏下载徽标原样抽出，行为逐字不变（抽取是重构，不是改行为）。
 */

/** 状态栏条目的共用外壳类：h-[22px] + rounded-sm + font-mono 11.5px。
 * gap 由调用方按内容密度自定（图标+文字用 1.5，纯文字用 1），不内置在这里——
 * 四个引用点（downloads-badge / theme-toggle / locale-toggle / status-bar-client）
 * 曾经各写一份几乎相同的类名，改一处漏三处，收敛成这一个导出常量。 */
export const STATUS_BAR_ITEM_CLASS =
  "flex h-[22px] items-center rounded-sm px-[9px] font-mono text-[11.5px] whitespace-nowrap";

/** 状态栏计量读数：条形填充 + 加粗主数字 + 悬浮明细 */
export interface GaugeReadout {
  /** 轨道填充百分比 0–100；数据缺失为 null（此时不画轨道，只显示 text） */
  percent: number | null;
  /** 加粗展示的主数字，如 "62%"；缺失为 "—" */
  text: string;
  /** 追加到悬浮 title 的明细，如 "显存 14.9 / 24.0 GiB · 利用率 8%"；无明细为 null */
  detail: string | null;
}

/** 条形色阶：占用越高越警示 */
export type GaugeTone = "normal" | "warn" | "critical";

/** 占用色阶阈值：85% 起转 --primary（琥珀），95% 起转 --accent-red。
 *  状态栏是常驻信息，阈值定高一点，免得平时就一直闪警示色 */
export function gaugeTone(percent: number | null): GaugeTone {
  if (percent === null || percent < 85) return "normal";
  return percent < 95 ? "warn" : "critical";
}

/** 越界 clamp 到 [0, 100]：利用率理论上不会越界，但除法结果不设防会让轨道溢出 */
function clampPercent(percent: number): number {
  return Math.min(100, Math.max(0, percent));
}

/** 统一装配读数：主数字恒由 percent 派生，四个格式化器不各写一遍取整与 — 兜底 */
function gauge(percent: number | null, detail: string | null): GaugeReadout {
  return { percent, text: percent !== null ? `${Math.round(percent)}%` : "—", detail };
}

/**
 * CPU 占用（host/stats）：条 = host.cpu_percent，
 * 悬浮明细 = "16 核 · 负载 1.42"（核数缺则只出负载，两者都缺则 null）
 */
export function formatCpuGauge(
  samples: { [metric: string]: LatestSample },
  cpuCount: number | null,
  labels: { cores: string; load: string },
): GaugeReadout {
  const cpuSample = samples[METRIC_IDS.hostCpuPercent];
  if (cpuSample === undefined) return gauge(null, null);

  const load1 = samples[METRIC_IDS.hostLoad1];
  const parts: string[] = [];
  if (cpuCount !== null) parts.push(`${cpuCount} ${labels.cores}`);
  if (load1 !== undefined) parts.push(`${labels.load} ${load1.value.toFixed(2)}`);

  return gauge(clampPercent(cpuSample.value), parts.length > 0 ? parts.join(" · ") : null);
}

/**
 * 宿主机内存占用：条 = host.mem_percent，
 * 悬浮明细 = "12.4 / 31.3 GiB"（used 或 total 缺其一则 null）
 */
export function formatMemGauge(
  samples: { [metric: string]: LatestSample },
  totalBytes: number | null,
): GaugeReadout {
  const memSample = samples[METRIC_IDS.hostMemPercent];
  if (memSample === undefined) return gauge(null, null);

  const usedSample = samples[METRIC_IDS.hostMemUsedBytes];
  const detail =
    usedSample !== undefined && totalBytes !== null
      ? `${(usedSample.value / 1024 ** 3).toFixed(1)} / ${(totalBytes / 1024 ** 3).toFixed(1)} GiB`
      : null;

  return gauge(clampPercent(memSample.value), detail);
}

/**
 * GPU：条 = 显存占用率（memUsed / memTotal），
 * 悬浮明细 = "显存 14.9 / 24.0 GiB · 利用率 8%"
 */
export function formatGpuGauge(
  totals: { memUsedMib: number; memTotalMib: number } | null,
  samples: { [metric: string]: LatestSample } | null,
  labels: { vram: string; util: string },
): GaugeReadout {
  const memKnown = totals !== null && totals.memTotalMib > 0;
  const percent = memKnown ? clampPercent((totals.memUsedMib / totals.memTotalMib) * 100) : null;

  const utilSample = samples?.[METRIC_IDS.gpuUtilPercent];
  const parts: string[] = [];
  // 显存单位用 GiB（1024³ 进制的准确写法）：监控页 metric-cards.tsx 的同一个数
  // 也标 GiB，两处不一致会让用户以为是两个不同的数；totals 单位是 MiB，用 /1024 换算
  if (memKnown) {
    parts.push(
      `${labels.vram} ${(totals.memUsedMib / 1024).toFixed(1)} / ${(totals.memTotalMib / 1024).toFixed(1)} GiB`,
    );
  }
  if (utilSample !== undefined) parts.push(`${labels.util} ${Math.round(utilSample.value)}%`);

  return gauge(percent, parts.length > 0 ? parts.join(" · ") : null);
}

/**
 * 磁盘（models 根所在分区）：条 = 已用占比（(total-free)/total），
 * 悬浮明细 = "873 / 1328 GB"
 */
export function formatDiskGauge(freeBytes: number | null, totalBytes: number | null): GaugeReadout {
  if (freeBytes === null || totalBytes === null || totalBytes <= 0) return gauge(null, null);
  // GB 用 /1024³ + Math.round：沿用磁盘卡在别处的取整口径，跟 GPU 显存
  // 刻意不同单位（GB vs GiB），保证明细里的数字跟它在概览页磁盘卡的样子对齐
  const usedGb = Math.round((totalBytes - freeBytes) / 1024 ** 3);
  const totalGb = Math.round(totalBytes / 1024 ** 3);

  return gauge(
    clampPercent(((totalBytes - freeBytes) / totalBytes) * 100),
    `${usedGb} / ${totalGb} GB`,
  );
}

/** 运行模型 chip 的端口后缀：":18080"；未知端口（模型行已删）不占位 */
export function formatPort(hostPort: number | null): string {
  return hostPort !== null ? `:${hostPort}` : "";
}

// ---- 下载条目派生（从旧顶栏下载徽标原样抽出，行为逐字不变）----

export interface DownloadTaskSnapshot {
  id: number;
  label: string;
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
    docTitle = `${pct !== null ? `${pct}% · ` : ""}${downloading.label} — ${BASE_TITLE}`;
  }
  if (queued > 0 && freshFailed === undefined) label = `${label} +${queued}`;

  return {
    label,
    title: downloading !== undefined ? downloading.label : labels.waiting,
    modelName: downloading !== undefined ? downloading.label : null,
    docTitle,
    failed: freshFailed !== undefined,
  };
}
