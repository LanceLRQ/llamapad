"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  BellRing,
  Check,
  Clock,
  Download,
  HardDriveDownload,
  History,
  ListOrdered,
  Loader2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";

import { PageHeader } from "@/components/shell/page-header";
import { SecondaryNav } from "@/components/shell/secondary-nav";
import { Toolbar } from "@/components/shell/toolbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { NewDownloadDialog } from "@/components/downloads/new-download-dialog";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "@/components/toast-store";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  computeDownloadsNavCounts,
  downloadsBlocks,
  queueRowsForView,
  resolveDownloadsView,
  type DownloadsView as DownloadsViewKind,
} from "@/lib/downloads-view";
import { formatSize, toGigabytes } from "@/lib/format";
import { estimateEtaSeconds, formatEta } from "@/lib/eta";
import { subscribeStream } from "@/lib/shared-event-source";
import { apiFetch } from "@/lib/api";

/**
 * 下载管理页交互组件（M2 Task 6，M3 Task 7 切 SSE）：接收 server 侧装配好的
 * tasks / history 初始数据，之后 EventSource /api/v1/downloads/stream 实时刷新
 * （history 连接首刷一次 / tasks 每 1s 全量快照）；暂停 / 继续 / 取消 / 重试
 * 调对应 API，成功后立即手动 fetch GET /api/v1/downloads 一次（见 runTaskAction）。
 *
 * 取舍（对照 ui-demo/downloads.html）：
 * - 速度：API 只回 downloaded_bytes（manager 不落速度），客户端用相邻两次
 *   快照的 bytes 差 / 时间差估算，仅对 downloading 任务展示（SSE 1s 节拍即
 *   估算窗口）
 * - 历史表列：模型 / 大小 / 文件数 / 状态 / 完成时间——demo 的「耗时」「sha256」
 *   两列在 download_history 表里没有对应数据（任务行也不落起止时刻与校验结果），
 *   与其放「—」占位不如不做，M3 补齐数据源后随 SSE 升级一起加列
 * - 任务视图只展示未完成行（pending/downloading/paused/failed）：completed 行
 *   的聚合信息在 history（manager 归档不删行，留在表里只会与历史重复）；
 *   cancelled 是有意丢弃，不展示
 */

/** 与 manager.DownloadTaskView 结构一致（客户端不 import server 模块） */
export interface DownloadTaskEntry {
  id: number;
  batchId: string;
  repoId: number | null;
  label: string;
  kind: "gguf" | "mmproj";
  /** "local" 是本地权重迁移的任务（移动/链接/复制），不是网络下载 */
  source: "hf" | "url" | "local";
  file: string;
  targetRel: string;
  shardIndex: number | null;
  shardTotal: number | null;
  expectedSize: number | null;
  sha256: string | null;
  status: "pending" | "downloading" | "paused" | "completed" | "failed" | "cancelled";
  downloadedBytes: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  queuePosition: number | null;
  /** source === "local" 时的手段（move / link / copy）；其余为 null */
  localAction: "move" | "link" | "copy" | null;
}

/** 与 GET /api/v1/downloads 的 history 行结构一致 */
export interface DownloadHistoryEntry {
  id: number;
  batchId: string;
  label: string;
  files: { file: string; target_rel: string; bytes: number }[];
  totalBytes: number;
  status: string;
  finishedAt: string;
  /** 本地获取批次的源路径与手段（归档时写入）；纯下载批次为 null。
   *  localAction 可能是逗号分隔的多个动作（同一批里既有移动又有链接） */
  sourcePath: string | null;
  localAction: string | null;
}

/** ISO 时间 → 固定数字格式（sv-SE 技巧与设置页命名空间卡同款，SSR/CSR 输出一致） */
function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** kind 徽标：gguf / mmproj（技术名，不做 i18n） */
function KindBadge({ kind }: { kind: "gguf" | "mmproj" }) {
  return (
    <Badge variant="outline" className="font-mono text-xs text-muted-foreground">
      {kind}
    </Badge>
  );
}

/**
 * 本地获取角标（移动 / 链接 / 复制）：这类任务不走网络，速度恒 0 B/s、常常
 * 瞬间完成，不标出来的话它在下载页看着就是一条「诡异的下载」。
 *
 * `actions` 是逗号分隔的动作串（任务行只有一个；历史行是整批的摘要，同一批
 * 里既有移动又有链接时会是 "move,link"），为 null / 空串时不渲染。
 */
function LocalActionBadge({ actions }: { actions: string | null }) {
  const t = useTranslations("pages.downloads");
  const known = (actions ?? "").split(",").filter((a) => a === "move" || a === "link" || a === "copy");
  if (known.length === 0) return null;
  return (
    <Badge variant="outline" className="text-xs text-muted-foreground">
      <HardDriveDownload className="size-3" />
      {known.map((a) => t(`localAction${a[0]!.toUpperCase()}${a.slice(1)}`)).join(" / ")}
    </Badge>
  );
}

/** 状态徽标着色对齐模型页：绿=完成 / 红=失败 / amber=暂停 / 灰=排队·取消 / 主色=下载中 */
function TaskStatusBadge({ status }: { status: DownloadTaskEntry["status"] }) {
  const t = useTranslations("pages.downloads");
  switch (status) {
    case "downloading":
      return (
        <Badge variant="outline" className="border-primary/25 bg-primary/10 text-primary">
          <Loader2 className="animate-spin" />
          {t("statusDownloading")}
        </Badge>
      );
    case "paused":
      return (
        <Badge
          variant="outline"
          className="border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
        >
          <Pause className="size-3!" />
          {t("statusPaused")}
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="outline" className="border-accent-red/25 bg-accent-red/10 text-accent-red">
          <TriangleAlert className="size-3!" />
          {t("statusFailed")}
        </Badge>
      );
    case "pending":
      return (
        <Badge variant="outline" className="text-muted-foreground">
          <Clock className="size-3!" />
          {t("statusPending")}
        </Badge>
      );
    case "cancelled":
      return (
        <Badge variant="outline" className="text-muted-foreground">
          <X className="size-3!" />
          {t("statusCancelled")}
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" className="border-accent-green/25 bg-accent-green/10 text-accent-green">
          <Check className="size-3!" />
          {t("statusCompleted")}
        </Badge>
      );
  }
}

/** 操作按钮组：下载中=暂停+取消；暂停=继续+取消；失败=重试+取消 */
function TaskActions({
  task,
  busy,
  onAction,
  onRetry,
}: {
  task: DownloadTaskEntry;
  busy: string | null;
  onAction: (task: DownloadTaskEntry, action: "pause" | "resume" | "cancel") => void;
  onRetry: (task: DownloadTaskEntry) => void;
}) {
  const t = useTranslations("pages.downloads");
  const isBusy = (action: string) => busy === `${task.id}:${action}`;
  const anyBusy = busy !== null && busy.startsWith(`${task.id}:`);
  return (
    <div className="flex items-center gap-1">
      {task.status === "downloading" && (
        <Button variant="outline" size="sm" disabled={anyBusy} onClick={() => onAction(task, "pause")}>
          {isBusy("pause") ? <Loader2 className="animate-spin" /> : <Pause className="size-3.5" />}
          {isBusy("pause") ? t("actionPausing") : t("actionPause")}
        </Button>
      )}
      {task.status === "paused" && (
        <Button variant="outline" size="sm" disabled={anyBusy} onClick={() => onAction(task, "resume")}>
          {isBusy("resume") ? <Loader2 className="animate-spin" /> : <Play className="size-3.5" />}
          {isBusy("resume") ? t("actionResuming") : t("actionResume")}
        </Button>
      )}
      {task.status === "failed" && (
        <Button variant="outline" size="sm" disabled={anyBusy} title={t("retryTitle")} onClick={() => onRetry(task)}>
          {isBusy("retry") ? <Loader2 className="animate-spin" /> : <RotateCcw className="size-3.5" />}
          {isBusy("retry") ? t("actionRetrying") : t("actionRetry")}
        </Button>
      )}
      <Button variant="destructive" size="sm" disabled={anyBusy} onClick={() => onAction(task, "cancel")}>
        {isBusy("cancel") ? <Loader2 className="animate-spin" /> : <X className="size-3.5" />}
        {isBusy("cancel") ? t("actionCanceling") : t("actionCancel")}
      </Button>
    </div>
  );
}

/** 同模型其余任务的状态小图标（分片明细行用；单并发下不会出现第二个 downloading） */
function SiblingStatusIcon({ status }: { status: DownloadTaskEntry["status"] }) {
  switch (status) {
    case "completed":
      return <Check className="size-3.5 shrink-0 text-accent-green" />;
    case "paused":
      return <Pause className="size-3.5 shrink-0 text-amber-500" />;
    case "failed":
      return <TriangleAlert className="size-3.5 shrink-0 text-accent-red" />;
    default:
      return <Clock className="size-3.5 shrink-0 text-muted-foreground/60" />;
  }
}

/**
 * 当前任务卡：队首任务（downloading 优先，否则队列停住的最早 failed/paused 行）。
 * expected 已知 → 百分比 + 进度条；未知 → 转圈示意；failed → 红色错误行 + 重试。
 */
function CurrentTaskCard({
  task,
  siblings,
  speed,
  busy,
  error,
  onAction,
  onRetry,
}: {
  task: DownloadTaskEntry;
  siblings: DownloadTaskEntry[];
  speed: number | undefined;
  busy: string | null;
  error: string | null;
  onAction: (task: DownloadTaskEntry, action: "pause" | "resume" | "cancel") => void;
  onRetry: (task: DownloadTaskEntry) => void;
}) {
  const t = useTranslations("pages.downloads");
  const pct =
    task.expectedSize !== null && task.expectedSize > 0
      ? Math.min(100, (task.downloadedBytes / task.expectedSize) * 100)
      : null;
  // ETA（UX P0 Task 10）：速度差分可得且总大小已知才有意义
  const eta =
    task.expectedSize !== null && speed !== undefined && speed > 0
      ? estimateEtaSeconds(task.expectedSize - task.downloadedBytes, speed)
      : null;

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[15px] leading-tight font-semibold">{task.label}</span>
              <KindBadge kind={task.kind} />
              <LocalActionBadge actions={task.source === "local" ? task.localAction : null} />
              {task.shardTotal !== null && task.shardIndex !== null && (
                <Badge variant="outline" className="font-mono text-xs text-muted-foreground">
                  {t("shardOf", { index: task.shardIndex, total: task.shardTotal })}
                </Badge>
              )}
              <TaskStatusBadge status={task.status} />
            </div>
            <span className="truncate font-mono text-xs text-muted-foreground" title={task.targetRel}>
              {task.targetRel}
            </span>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <TaskActions task={task} busy={busy} onAction={onAction} onRetry={onRetry} />
            {error && <p className="text-xs whitespace-normal text-destructive">{error}</p>}
          </div>
        </div>

        {task.status === "failed" && (
          <p
            className="break-all rounded-lg bg-destructive/10 px-2.5 py-2 font-mono text-xs text-destructive"
            title={task.error ?? undefined}
          >
            {task.error ?? t("statusFailed")}
          </p>
        )}

        {task.status !== "failed" && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3 font-mono text-[13px] tabular-nums">
              <span>
                {formatSize(task.downloadedBytes)}
                <span className="text-muted-foreground">
                  {" / "}
                  {task.expectedSize !== null ? formatSize(task.expectedSize) : "…"}
                </span>
              </span>
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {pct === null ? (
                  task.status === "downloading" && (
                    <>
                      <Loader2 className="size-3 animate-spin" />
                      {t("unknownSize")}
                    </>
                  )
                ) : (
                  <>
                    {Math.floor(pct)}%
                    {speed !== undefined && speed > 0 && <> · {formatSize(speed)}/s</>}
                    {eta !== null && <> · {t("etaRemaining", { eta: formatEta(eta) })}</>}
                  </>
                )}
              </span>
            </div>
            {/* expected 未知时不画占比条（0% 或满格都有误导），只以转圈示意进行中 */}
            {pct !== null && (
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-500"
                  style={{ width: `${pct}%` }}
                />
              </div>
            )}
          </div>
        )}

        {/* 分片 / 同模型其余文件明细（对照 demo 的分片行）；失败分片行内原地重试（U25） */}
        {siblings.length > 0 && (
          <div className="flex flex-col gap-1 border-t pt-2.5">
            {siblings.map((s) => (
              <div key={s.id} className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                <SiblingStatusIcon status={s.status} />
                <span className="min-w-0 flex-1 truncate" title={s.targetRel}>
                  {s.file}
                </span>
                {s.status === "failed" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 gap-1 px-1.5 text-xs"
                    disabled={busy !== null}
                    title={t("retryTitle")}
                    onClick={() => onRetry(s)}
                  >
                    {busy === `${s.id}:retry` ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <RotateCcw className="size-3" />
                    )}
                    {t("actionRetry")}
                  </Button>
                )}
                <span className="shrink-0 tabular-nums">
                  {s.status === "completed"
                    ? formatSize(s.downloadedBytes)
                    : s.expectedSize !== null
                      ? formatSize(s.expectedSize)
                      : "—"}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** 队列表：未完成行（pending/paused/failed，排除当前卡同组），目标路径 mono 副文本 */
function QueueCard({
  tasks,
  busy,
  errors,
  onAction,
  onRetry,
}: {
  tasks: DownloadTaskEntry[];
  busy: string | null;
  errors: Map<number, string>;
  onAction: (task: DownloadTaskEntry, action: "pause" | "resume" | "cancel") => void;
  onRetry: (task: DownloadTaskEntry) => void;
}) {
  const t = useTranslations("pages.downloads");

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center gap-2.5 border-b px-4 py-3">
        <ListOrdered className="size-4 text-muted-foreground" />
        <span className="text-sm font-semibold">{t("queueTitle")}</span>
        <span className="text-xs text-muted-foreground">{t("queueCount", { count: tasks.length })}</span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[110px]">{t("colStatus")}</TableHead>
            <TableHead>{t("colTask")}</TableHead>
            <TableHead className="w-[130px]">{t("colSize")}</TableHead>
            <TableHead className="w-[90px]">{t("colShard")}</TableHead>
            <TableHead className="w-[240px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {tasks.map((task) => (
            <TableRow key={task.id}>
              <TableCell>
                <div className="flex flex-col items-start gap-1">
                  <TaskStatusBadge status={task.status} />
                  {task.status === "pending" && task.queuePosition !== null && (
                    <span className="text-xs text-muted-foreground">
                      {t("queuePosition", { position: task.queuePosition + 1 })}
                    </span>
                  )}
                </div>
              </TableCell>
              <TableCell>
                <div className="flex min-w-0 flex-col">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-mono text-[13px] font-semibold">{task.label}</span>
                    <LocalActionBadge actions={task.source === "local" ? task.localAction : null} />
                  </span>
                  <span className="truncate font-mono text-xs text-muted-foreground" title={task.targetRel}>
                    {task.targetRel}
                  </span>
                  {task.status === "failed" && task.error && (
                    <span
                      className="truncate text-xs text-destructive"
                      title={task.error}
                    >
                      {task.error}
                    </span>
                  )}
                </div>
              </TableCell>
              <TableCell className="font-mono text-[13px] tabular-nums">
                {task.expectedSize === null ? (
                  <span className="text-muted-foreground">—</span>
                ) : task.status === "paused" && task.downloadedBytes > 0 ? (
                  <>
                    {formatSize(task.downloadedBytes)}
                    <span className="text-muted-foreground"> / {formatSize(task.expectedSize)}</span>
                  </>
                ) : (
                  formatSize(task.expectedSize)
                )}
              </TableCell>
              <TableCell className="font-mono text-[13px] tabular-nums">
                {task.shardTotal !== null && task.shardIndex !== null ? (
                  `${task.shardIndex}/${task.shardTotal}`
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell>
                <div className="flex flex-col items-start gap-1">
                  <TaskActions task={task} busy={busy} onAction={onAction} onRetry={onRetry} />
                  {errors.has(task.id) && (
                    <p className="text-xs whitespace-normal text-destructive">{errors.get(task.id)}</p>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

/** 历史表：模型 / 大小 / 文件数 / 状态 / 完成时间（列取舍见文件头注释）；头部清除入口（U25） */
function HistoryCard({
  history,
  clearing,
  onClear,
}: {
  history: DownloadHistoryEntry[];
  clearing: boolean;
  onClear: () => void;
}) {
  const t = useTranslations("pages.downloads");
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center gap-2.5 border-b px-4 py-3">
        <History className="size-4 text-muted-foreground" />
        <span className="text-sm font-semibold">{t("historyTitle")}</span>
        <span className="text-xs text-muted-foreground">{t("historyCount", { count: history.length })}</span>
        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogTrigger
            render={
              <Button variant="ghost" size="sm" className="ml-auto text-muted-foreground" />
            }
          >
            <Trash2 className="size-3.5" />
            {t("clearHistory")}
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("clearHistoryTitle")}</DialogTitle>
              <DialogDescription>{t("clearHistoryBody")}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose render={<Button variant="outline" />}>{t("actionCancel")}</DialogClose>
              <Button
                variant="destructive"
                disabled={clearing}
                onClick={() => {
                  setConfirmOpen(false);
                  onClear();
                }}
              >
                {clearing ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                {t("clearHistoryConfirm")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("colModel")}</TableHead>
            <TableHead className="w-[90px]">{t("colSize")}</TableHead>
            <TableHead className="w-[70px]">{t("colFileCount")}</TableHead>
            <TableHead className="w-[90px]">{t("colStatus")}</TableHead>
            <TableHead className="w-[150px]">{t("colFinishedAt")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {history.map((entry) => (
            <TableRow key={entry.id}>
              <TableCell>
                <div className="flex min-w-0 flex-col">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-mono text-[13px] font-semibold">{entry.label}</span>
                    {/* 本地获取的批次：源路径进 title，不占列宽 */}
                    <span title={entry.sourcePath ?? undefined}>
                      <LocalActionBadge actions={entry.localAction} />
                    </span>
                  </span>
                  <span
                    className="truncate font-mono text-xs text-muted-foreground"
                    title={entry.files.map((f) => f.file).join(", ")}
                  >
                    {entry.files[0]?.file ?? "—"}
                    {entry.files.length > 1 && (
                      <span className="text-muted-foreground"> +{entry.files.length - 1}</span>
                    )}
                  </span>
                </div>
              </TableCell>
              <TableCell className="font-mono text-[13px] tabular-nums">
                {formatSize(entry.totalBytes)}
              </TableCell>
              <TableCell className="font-mono text-[13px] tabular-nums">{entry.files.length}</TableCell>
              <TableCell>
                <TaskStatusBadge status={entry.status === "completed" ? "completed" : "failed"} />
              </TableCell>
              <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                {formatDateTime(entry.finishedAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

/**
 * 空态引导（I7 修复）：此前按钮指向新建模型向导，但向导已在批 5 瘦身成
 * 「从已落盘的 gguf 里选一个」，全新安装时磁盘上还没有任何 gguf，点进去
 * 第一步的文件选择器空空如也，是条死胡同。改成直接唤起本组件已有的
 * 「新建下载」弹层——onNewDownload 由外层传入，与顶栏 Toolbar 的
 * 「新建下载」按钮共用同一个 open state。
 */
function EmptyState({ onNewDownload }: { onNewDownload: () => void }) {
  const t = useTranslations("pages.downloads");
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <Download className="size-6" />
        </span>
        <p className="text-sm font-medium">{t("emptyTitle")}</p>
        <p className="max-w-md text-sm text-muted-foreground">{t("emptyDescription")}</p>
        <Button size="sm" className="mt-1" onClick={onNewDownload}>
          <Plus className="size-3.5" />
          {t("emptyAction")}
        </Button>
      </CardContent>
    </Card>
  );
}

/** busy 闸门里代表队列级操作的 key（任务级用 "${id}:${action}"，不会与之冲突） */
const QUEUE_RESUME_KEY = "queue:resume";
const HISTORY_CLEAR_KEY = "history:clear";

/** 二级栏六格 → PageHeader 标题 / 副题 / 切片空态文案的 i18n key（M16 T7） */
const VIEW_TITLE_KEY: Record<DownloadsViewKind, string> = {
  queue: "navQueue",
  downloading: "navDownloading",
  pending: "navPending",
  paused: "navPaused",
  failed: "navFailed",
  history: "navHistory",
};
const VIEW_SUB_KEY: Record<DownloadsViewKind, string> = {
  queue: "navQueueSub",
  downloading: "navDownloadingSub",
  pending: "navPendingSub",
  paused: "navPausedSub",
  failed: "navFailedSub",
  history: "navHistorySub",
};
// 分视图文案而非一条带 {view} 参数的通用键：通用键在 history 上会拼出
// "没有历史记录的任务" 这种不通顺的组合（历史是"记录"不是"任务"），
// 分开写每一格都能挑最自然的说法，多付的 5 个 key 换清晰度值得
const VIEW_EMPTY_KEY: Record<DownloadsViewKind, string> = {
  queue: "viewEmptyQueue",
  downloading: "viewEmptyDownloading",
  pending: "viewEmptyPending",
  paused: "viewEmptyPaused",
  failed: "viewEmptyFailed",
  history: "viewEmptyHistory",
};

export function DownloadsView({
  initialTasks,
  initialHistory,
  folders,
}: {
  initialTasks: DownloadTaskEntry[];
  initialHistory: DownloadHistoryEntry[];
  folders: string[];
}) {
  const t = useTranslations("pages.downloads");
  // 二级栏视图（M16 T7）：计数与 meta 是每秒变的实时数据，不能在 server 侧算，
  // 所以 view 由本组件自己从 useSearchParams() 读，不经 page.tsx 的 searchParams
  // prop 转手——page.tsx 完全不碰 view，避免两处状态源不一致
  const searchParams = useSearchParams();
  const view = resolveDownloadsView(searchParams.get("view") ?? undefined);
  const blocks = downloadsBlocks(view);
  const [tasks, setTasks] = useState(initialTasks);
  const [history, setHistory] = useState(initialHistory);
  /** 任务 id → 估算速度（bytes/s；由相邻快照差分得出，仅 downloading 行有值） */
  const [speeds, setSpeeds] = useState<Record<number, number>>({});
  const lastSnapshot = useRef(new Map<number, { bytes: number; at: number }>());

  /** 按钮级 busy 标记（`${taskId}:${action}`）和行内错误提示 */
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ id: number; message: string } | null>(null);
  /** 页头「新建下载」弹层（批 6 任务 12）：受控 open，与 chart-dialog.tsx 同款模式 */
  const [newDownloadOpen, setNewDownloadOpen] = useState(false);

  /** 应用一拍 tasks 快照：速度差分（相邻快照 bytes 差 / 时间差）+ 整表替换 */
  const applyTasks = useCallback((incoming: DownloadTaskEntry[]): void => {
    const now = Date.now();
    const nextSpeeds: Record<number, number> = {};
    for (const task of incoming) {
      const prev = lastSnapshot.current.get(task.id);
      if (prev && now > prev.at && task.downloadedBytes > prev.bytes) {
        nextSpeeds[task.id] = ((task.downloadedBytes - prev.bytes) * 1000) / (now - prev.at);
      }
      lastSnapshot.current.set(task.id, { bytes: task.downloadedBytes, at: now });
    }
    setTasks(incoming);
    setSpeeds(nextSpeeds);
  }, []);

  /**
   * 手动整页刷新（GET /api/v1/downloads）。仅操作后即时反馈用：SSE 下一拍最多
   * 1s，但暂停/取消等按钮的成功反馈等 1s 会显得"卡了"——保留这一个小轮询点，
   * 其余实时性全部交给常连接的 SSE。
   */
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await apiFetch("/api/v1/downloads", { cache: "no-store" });
      if (!res.ok) return; // 非成功态（如 401）：保持现有数据，SSE 常连自愈
      const data = (await res.json()) as { tasks: DownloadTaskEntry[]; history: DownloadHistoryEntry[] };
      applyTasks(data.tasks);
      setHistory(data.history);
    } catch {
      // 网络抖动：静默保留上次数据（SSE 常连，下一拍即恢复）
    }
  }, [applyTasks]);

  useEffect(() => {
    // SSR 初始快照做速度差分基线（首拍 SSE 的 bytes 增量即第一段速度）
    const now = Date.now();
    for (const task of initialTasks) {
      lastSnapshot.current.set(task.id, { bytes: task.downloadedBytes, at: now });
    }

    // 实时性策略（M3 Task 7，还 M2 决策记录的债）：SSE 常连接替代 2s 轮询——
    // tasks 每 1s 一拍全量快照、history 连接首刷一次。断线由 EventSource 浏览器
    // 默认自动重连，重连后首刷即对齐，无需手动处理。
    // 页面可见性不特殊处理（删除原 visibilitychange 逻辑）：后台标签页连接保持、
    // 收到更新仅做 React state 更新（无 DOM 焦点竞争，代价可接受）；若要省电可
    // 在 document.hidden 时 es.close() + 回前台重连——重连抖动与首拍延迟不值，
    // 不做。
    // 共享连接（UX P0 走查修复）：顶栏徽标与本视图同订本端点，去重后每页一条
    const unsubscribe = subscribeStream("/api/v1/downloads/stream", {
      onData: (raw) => {
        let msg: { type?: string; tasks?: DownloadTaskEntry[]; history?: DownloadHistoryEntry[] };
        try {
          msg = JSON.parse(raw);
        } catch {
          return; // 半截帧：丢弃等下一拍（1s 节拍自愈）
        }
        if (msg.type === "tasks" && Array.isArray(msg.tasks)) applyTasks(msg.tasks);
        else if (msg.type === "history" && Array.isArray(msg.history)) setHistory(msg.history);
      },
    });
    return unsubscribe;
  }, [applyTasks, initialTasks]);

  async function runTaskAction(
    task: DownloadTaskEntry,
    action: "pause" | "resume" | "cancel",
  ): Promise<void> {
    const key = `${task.id}:${action}`;
    if (busy !== null) return;
    setBusy(key);
    setActionError(null);
    try {
      const res = await apiFetch(`/api/v1/downloads/${task.id}/${action}`, { method: "POST" });
      if (res.ok) {
        await refresh(); // 操作成功立即手动刷新（SSE 下一拍最多 1s，即时反馈更好）
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setActionError({
        id: task.id,
        message: res.status === 404 ? t("errorTaskNotFound") : (body?.error ?? t("errorRequest")),
      });
    } catch {
      setActionError({ id: task.id, message: t("errorNetwork") });
    } finally {
      setBusy(null);
    }
  }

  async function runRetry(task: DownloadTaskEntry): Promise<void> {
    const key = `${task.id}:retry`;
    if (busy !== null) return;
    setBusy(key);
    setActionError(null);
    try {
      // 原地重试（U25）：failed/cancelled 行回 pending（.part 在则续传），
      // 分片粒度——单文件失败不再连坐整组重新下单
      const res = await apiFetch(`/api/v1/downloads/${task.id}/retry`, { method: "POST" });
      if (res.ok) {
        await refresh();
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setActionError({
        id: task.id,
        message: res.status === 404 ? t("errorTaskNotFound") : (body?.error ?? t("errorRequest")),
      });
    } catch {
      setActionError({ id: task.id, message: t("errorNetwork") });
    } finally {
      setBusy(null);
    }
  }

  async function clearHistory(): Promise<void> {
    if (busy !== null) return;
    setBusy(HISTORY_CLEAR_KEY);
    try {
      const res = await apiFetch("/api/v1/downloads/history", { method: "DELETE" });
      if (res.ok) {
        toast.success(t("historyCleared"));
        await refresh(); // history 帧只在 SSE 连接建立时发一次，清除后必须手动拉
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(body?.error ?? t("errorRequest"));
    } catch {
      toast.error(t("errorNetwork"));
    } finally {
      setBusy(null);
    }
  }

  async function resumeQueue(): Promise<void> {
    if (busy !== null) return;
    setBusy(QUEUE_RESUME_KEY);
    setActionError(null);
    try {
      const res = await apiFetch("/api/v1/downloads/resume", { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      await refresh();
    } catch {
      setActionError({ id: -1, message: t("errorRequest") });
    } finally {
      setBusy(null);
    }
  }

  // 视图拆分：只看未完成行；当前卡 = downloading 优先，否则队列停住的最早 failed/paused
  const unfinished = tasks.filter((task) => task.status !== "completed" && task.status !== "cancelled");
  const active = unfinished.find((task) => task.status === "downloading") ?? null;
  const cardTask =
    active ??
    (unfinished
      .filter((task) => task.status === "failed" || task.status === "paused")
      .sort((a, b) => a.id - b.id)[0] ??
      null);
  const siblings =
    cardTask !== null
      ? tasks.filter(
          (task) =>
            task.batchId === cardTask.batchId && task.id !== cardTask.id && task.status !== "cancelled",
        )
      : [];
  const queueTasks = unfinished.filter(
    (task) => task.id !== cardTask?.id && task.batchId !== cardTask?.batchId,
  );
  const isEmpty = unfinished.length === 0 && history.length === 0;
  const errors = actionError === null ? new Map<number, string>() : new Map([[actionError.id, actionError.message]]);

  // 队列停摆：有排队任务却没有任何一个在下载。后端在连续失败 3 次时会停队并记
  // download.queue_stalled 事件，但事件是历史记录，判当前态要看任务快照
  const queueStalled =
    tasks.some((t) => t.status === "pending") && !tasks.some((t) => t.status === "downloading");

  // 浏览器通知授权（UX P0 Task 10）：完成后系统级提醒；只在未决态显示入口
  const [notifyPermission, setNotifyPermission] = useState<NotificationPermission | "unsupported">(
    () => (typeof Notification === "undefined" ? "unsupported" : Notification.permission),
  );
  async function enableNotifications(): Promise<void> {
    if (typeof Notification === "undefined") return;
    setNotifyPermission(await Notification.requestPermission());
  }

  // 当前卡在「进行中」视图下的额外校验（T7 新增，cardTask 本身的选取逻辑不动）：
  // 没有真正 downloading 记录时 cardTask 会回退取队列停住的最早 failed/paused
  // 行——这个回退在「队列」总览视图下是对的（正是需要被看见的堵点），但切到
  // 「进行中」视图后再显示同一张回退卡，就会挂着"下载中"的标题展示一个暂停/
  // 失败的任务，所以这里只在非 downloading 视图，或 cardTask 确实在下载时才
  // 让大卡出现
  const cardVisible =
    blocks.current && cardTask !== null && (view !== "downloading" || cardTask.status === "downloading");

  // 队列表按视图过滤（T7）：cardVisible 时沿用既有的 queueTasks（已排除大卡
  // 所属模型组，避免大卡内容在表里重复出现）；大卡不出现的视图（pending/
  // paused/failed）改用未过滤的 unfinished——否则 queueTasks 里被排除掉的
  // 那一行（比如队列停住、被选为大卡候选的那条 failed 记录）会在「已失败」
  // 视图里彻底消失：大卡不显示、表里也被排除在外，用户在这个视图下永远找不到它
  const visibleQueueRows = queueRowsForView(view, cardVisible ? queueTasks : unfinished);

  // Toolbar「显示 N / M」：没有 chip 维度的页面分母取全量（对齐 files 页
  // file-meta-table.tsx 的做法）——history 视图的全量是历史条数，其余视图的
  // 全量是未完成总数（深链切视图时这个分母不跳动）；分子是这个视图实际渲染
  // 的行数：大卡算 1 行 + 队列表可见行数
  const shownCount = (cardVisible ? 1 : 0) + visibleQueueRows.length;
  const toolbarNote =
    view === "history"
      ? { shown: history.length, total: history.length }
      : { shown: shownCount, total: unfinished.length };

  // 切片空态（T7 新增）：整页并不 isEmpty（别处还有数据），但当前视图这一段
  // 流水线什么都没有——不能什么都不渲染，空白页看起来像坏了
  const sliceHasContent =
    cardVisible || (blocks.queue && visibleQueueRows.length > 0) || (blocks.history && history.length > 0);
  const sliceEmpty = !isEmpty && !sliceHasContent;

  const counts = computeDownloadsNavCounts(tasks, history, speeds);
  // 速度为 0 时不能直接拼 "—/s"（formatSize(0) 已经是 "—"），得先判是否有速度
  const queueSpeedMeta = counts.queue.speedBytesPerSec > 0 ? `${formatSize(counts.queue.speedBytesPerSec)}/s` : "—";
  // 顶栏速度读数：设计稿把单位放在 label 位（46.8 + "MB/s"），这里只出数值，
  // 无任务下载时传 0 交给 formatStat 自动显示 "—"
  const speedStatValue =
    counts.queue.speedBytesPerSec > 0 ? Math.round((counts.queue.speedBytesPerSec / 1024 ** 2) * 10) / 10 : 0;

  const navItems = [
    {
      key: "queue",
      name: t("navQueue"),
      lead: { kind: "count" as const, value: counts.queue.count },
      meta: queueSpeedMeta,
      marker: counts.queue.hasActive ? { tone: "running" as const, title: t("navQueueActiveTooltip") } : undefined,
    },
    {
      key: "downloading",
      name: t("navDownloading"),
      lead: { kind: "count" as const, value: counts.downloading.count },
      meta: formatSize(counts.downloading.bytes),
    },
    {
      key: "pending",
      name: t("navPending"),
      lead: { kind: "count" as const, value: counts.pending.count },
      meta: formatSize(counts.pending.bytes),
    },
    {
      key: "paused",
      name: t("navPaused"),
      lead: { kind: "count" as const, value: counts.paused.count },
      // paused 给两个数：断点位置（已下）与总量，对应设计稿 "6.7 / 11.4 GB"。
      // 一条都没有时退回单个 "—"：拼出来的 "— / —" 会跟其余状态格的 "—"
      // 对不齐，看起来像这一格坏了而不是空了
      meta:
        counts.paused.count > 0
          ? `${formatSize(counts.paused.downloadedBytes)} / ${formatSize(counts.paused.totalBytes)}`
          : "—",
    },
    {
      key: "failed",
      name: t("navFailed"),
      lead: { kind: "count" as const, value: counts.failed.count },
      meta: formatSize(counts.failed.bytes),
    },
    {
      key: "history",
      name: t("navHistory"),
      lead: { kind: "count" as const, value: counts.history.count },
      meta: formatSize(counts.history.bytes),
    },
  ];

  return (
    <>
      <SecondaryNav
        kicker="DOWNLOADS"
        title={t("title")}
        items={navItems}
        queryKey="view"
        current={view}
        groups={[
          { beforeKey: "downloading", label: "STATES" },
          { beforeKey: "history", label: "ARCHIVE" },
        ]}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader
          icon={Download}
          title={t(VIEW_TITLE_KEY[view])}
          subtitle={t(VIEW_SUB_KEY[view])}
          // 四项 stats 不随视图变：设计稿的顶栏读数是全局事实，切片不改变它们
          stats={[
            { value: counts.queue.count, label: t("statUnfinished"), tone: "hot" },
            { value: speedStatValue, label: t("statSpeed") },
            { value: counts.history.count, label: t("statHistory") },
            { value: toGigabytes(counts.history.bytes), unit: "GB", label: t("statTotal") },
          ]}
        />

        <Toolbar
          chips={[]}
          activeChip=""
          onChipChange={() => {}}
          note={toolbarNote}
          action={
            <>
              {notifyPermission === "default" && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={() => void enableNotifications()}
                >
                  <BellRing className="size-3.5" />
                  {t("notifyEnable")}
                </Button>
              )}
              <Button size="sm" onClick={() => setNewDownloadOpen(true)}>
                <Plus className="size-3.5" />
                {t("newDownload")}
              </Button>
            </>
          }
        />

        <NewDownloadDialog open={newDownloadOpen} onOpenChange={setNewDownloadOpen} folders={folders} />

        <div className="min-h-0 flex-1 overflow-y-auto px-7 py-5">
          {isEmpty ? (
            <EmptyState onNewDownload={() => setNewDownloadOpen(true)} />
          ) : (
            <div className="flex flex-col gap-3.5">
              {blocks.warn && queueStalled && (
                <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-sm text-amber-700 dark:text-amber-400">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                  <div className="flex flex-1 flex-col gap-1.5">
                    <span>{t("queueStalledHint")}</span>
                    <div>
                      <Button size="sm" variant="outline" disabled={busy !== null} onClick={resumeQueue}>
                        {busy === QUEUE_RESUME_KEY ? t("queueResuming") : t("queueResume")}
                      </Button>
                    </div>
                  </div>
                </div>
              )}
              {sliceEmpty ? (
                <Card>
                  <CardContent className="flex items-center justify-center py-10 text-center text-sm text-muted-foreground">
                    {t(VIEW_EMPTY_KEY[view])}
                  </CardContent>
                </Card>
              ) : (
                <>
                  {cardVisible && cardTask !== null && (
                    <CurrentTaskCard
                      task={cardTask}
                      siblings={siblings}
                      speed={speeds[cardTask.id]}
                      busy={busy}
                      error={actionError?.id === cardTask.id ? actionError.message : null}
                      onAction={(task, action) => void runTaskAction(task, action)}
                      onRetry={(task) => void runRetry(task)}
                    />
                  )}
                  {blocks.queue && visibleQueueRows.length > 0 && (
                    <QueueCard
                      tasks={visibleQueueRows}
                      busy={busy}
                      errors={errors}
                      onAction={(task, action) => void runTaskAction(task, action)}
                      onRetry={(task) => void runRetry(task)}
                    />
                  )}
                  {blocks.history && history.length > 0 && (
                    <HistoryCard
                      history={history}
                      clearing={busy === HISTORY_CLEAR_KEY}
                      onClear={() => void clearHistory()}
                    />
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
