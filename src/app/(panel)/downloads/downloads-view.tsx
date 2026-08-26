"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  ArrowRight,
  BellRing,
  Check,
  Clock,
  Download,
  History,
  ListOrdered,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  TriangleAlert,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatSize } from "@/lib/format";
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
  model: string;
  kind: "gguf" | "mmproj";
  source: "hf" | "url";
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
}

/** 与 GET /api/v1/downloads 的 history 行结构一致 */
export interface DownloadHistoryEntry {
  id: number;
  model: string;
  files: { file: string; target_rel: string; bytes: number }[];
  totalBytes: number;
  status: string;
  finishedAt: string;
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
              <span className="font-mono text-[15px] leading-tight font-semibold">{task.model}</span>
              <KindBadge kind={task.kind} />
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

        {/* 分片 / 同模型其余文件明细（对照 demo 的分片行） */}
        {siblings.length > 0 && (
          <div className="flex flex-col gap-1 border-t pt-2.5">
            {siblings.map((s) => (
              <div key={s.id} className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                <SiblingStatusIcon status={s.status} />
                <span className="min-w-0 flex-1 truncate" title={s.targetRel}>
                  {s.file}
                </span>
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
                  <span className="truncate font-mono text-[13px] font-semibold">{task.model}</span>
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

/** 历史表：模型 / 大小 / 文件数 / 状态 / 完成时间（列取舍见文件头注释） */
function HistoryCard({ history }: { history: DownloadHistoryEntry[] }) {
  const t = useTranslations("pages.downloads");

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center gap-2.5 border-b px-4 py-3">
        <History className="size-4 text-muted-foreground" />
        <span className="text-sm font-semibold">{t("historyTitle")}</span>
        <span className="text-xs text-muted-foreground">{t("historyCount", { count: history.length })}</span>
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
                  <span className="truncate font-mono text-[13px] font-semibold">{entry.model}</span>
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

/** 空态引导：无任务无历史时指向新建模型向导（/models/new 由紧随的 T7 提供） */
function EmptyState() {
  const t = useTranslations("pages.downloads");
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <Download className="size-6" />
        </span>
        <p className="text-sm font-medium">{t("emptyTitle")}</p>
        <p className="max-w-md text-sm text-muted-foreground">{t("emptyDescription")}</p>
        <Button size="sm" className="mt-1" render={<Link href="/models/new" />}>
          {t("emptyAction")}
          <ArrowRight className="size-3.5" />
        </Button>
      </CardContent>
    </Card>
  );
}

/** busy 闸门里代表队列级操作的 key（任务级用 "${id}:${action}"，不会与之冲突） */
const QUEUE_RESUME_KEY = "queue:resume";

export function DownloadsView({
  initialTasks,
  initialHistory,
}: {
  initialTasks: DownloadTaskEntry[];
  initialHistory: DownloadHistoryEntry[];
}) {
  const t = useTranslations("pages.downloads");
  const [tasks, setTasks] = useState(initialTasks);
  const [history, setHistory] = useState(initialHistory);
  /** 任务 id → 估算速度（bytes/s；由相邻快照差分得出，仅 downloading 行有值） */
  const [speeds, setSpeeds] = useState<Record<number, number>>({});
  const lastSnapshot = useRef(new Map<number, { bytes: number; at: number }>());

  /** 按钮级 busy 标记（`${taskId}:${action}`）和行内错误提示 */
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ id: number; message: string } | null>(null);

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
      // 不传 files：按模型 download 配置单文件重下（重试语义见按钮 title）
      const res = await apiFetch(`/api/v1/models/${task.model}/download`, { method: "POST" });
      if (res.status === 202) {
        await refresh();
        return;
      }
      let message = t("errorRequest");
      if (res.status === 404) message = t("errorModelNotFound");
      else if (res.status === 409) message = t("errorConflict");
      else if (res.status === 422) message = t("errorNoSource");
      else if (res.status === 507) message = t("errorDiskFull");
      setActionError({ id: task.id, message });
    } catch {
      setActionError({ id: task.id, message: t("errorNetwork") });
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
          (task) => task.model === cardTask.model && task.id !== cardTask.id && task.status !== "cancelled",
        )
      : [];
  const queueTasks = unfinished.filter(
    (task) => task.id !== cardTask?.id && task.model !== cardTask?.model,
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

  return (
    <div className="flex flex-col gap-3.5">
      {notifyPermission === "default" && (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground"
            onClick={() => void enableNotifications()}
          >
            <BellRing className="size-3.5" />
            {t("notifyEnable")}
          </Button>
        </div>
      )}
      {queueStalled && (
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
      {isEmpty ? (
        <EmptyState />
      ) : (
        <>
          {cardTask !== null && (
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
          {queueTasks.length > 0 && (
            <QueueCard
              tasks={queueTasks}
              busy={busy}
              errors={errors}
              onAction={(task, action) => void runTaskAction(task, action)}
              onRetry={(task) => void runRetry(task)}
            />
          )}
          {history.length > 0 && <HistoryCard history={history} />}
        </>
      )}
    </div>
  );
}
