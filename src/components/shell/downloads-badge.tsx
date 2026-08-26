"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Download, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";

import { toast } from "@/components/toast-store";
import { cn } from "@/lib/utils";
import { subscribeStream } from "@/lib/shared-event-source";

/**
 * 顶栏下载徽标（UX P0 Task 10 / U5）：订阅 /api/v1/downloads/stream（1s 快照），
 * 让"人在别的页面/后台标签页"也能看见下载进展——
 * - 徽标：下载中显示百分比（未知大小显示"下载中"）、失败变红、点击直达 /downloads；
 * - document.title：下载中改为 "43% · <模型> — llamapad"，空闲恢复；
 * - 完成/失败 toast（按任务状态迁移触发，首帧只建水位不补弹历史）；
 *   若浏览器通知已授权，同时发系统通知（授权入口在下载页）。
 *
 * 连接经 subscribeStream 与下载页视图共享（同端点每页一条，见
 * shared-event-source.ts 头注释的连接上限背景）。
 */

interface TaskSnapshot {
  id: number;
  model: string;
  status: "pending" | "downloading" | "paused" | "completed" | "failed" | "cancelled";
  downloadedBytes: number;
  expectedSize: number | null;
  updatedAt: string;
}

type TasksMessage = { type: "tasks"; tasks: TaskSnapshot[] };

const BASE_TITLE = "llamapad";

/** 失败信号新鲜度窗口：窗口外的 failed 不再点红徽标 */
const FRESH_FAILED_MS = 5 * 60_000;

export function DownloadsBadge() {
  const t = useTranslations("topbar");
  const td = useTranslations("pages.downloads");
  /** 徽标状态：null=无未完成任务（不渲染）；active=下载/排队/失败 */
  const [state, setState] = useState<{
    kind: "active";
    label: string;
    title: string;
    failed: boolean;
  } | null>(null);
  const previousStatuses = useRef<Map<number, TaskSnapshot["status"]> | null>(null);

  useEffect(() => {
    function onTasks(tasks: TaskSnapshot[]): void {
      // ---- 状态迁移 → toast / 系统通知（首帧只建水位）----
      const prev = previousStatuses.current;
      if (prev !== null) {
        for (const task of tasks) {
          const before = prev.get(task.id);
          if (before === undefined || before === task.status) continue;
          if (task.status === "completed") {
            toast.success(td("toastDone", { model: task.model }));
            if (typeof Notification !== "undefined" && Notification.permission === "granted") {
              new Notification(td("notifyDoneTitle"), { body: task.model });
            }
          } else if (task.status === "failed") {
            toast.error(td("toastFailed", { model: task.model }));
            if (typeof Notification !== "undefined" && Notification.permission === "granted") {
              new Notification(td("notifyFailedTitle"), { body: task.model });
            }
          }
        }
      }
      previousStatuses.current = new Map(tasks.map((task) => [task.id, task.status]));

      // ---- 徽标与 document.title ----
      const downloading = tasks.find((task) => task.status === "downloading");
      const queued = tasks.filter((task) => task.status === "pending").length;
      const paused = tasks.some((task) => task.status === "paused");
      // 失败信号新鲜度：failed 任务永留列表（供重试入口），陈年失败不该把
      // 徽标钉在红灯上——只认最近 5 分钟内失败的（快照 1s 一拍，到期自动恢复）
      const freshFailed = tasks.find(
        (task) =>
          task.status === "failed" && Date.now() - Date.parse(task.updatedAt) < FRESH_FAILED_MS,
      );
      const active = downloading !== undefined || queued > 0 || paused || freshFailed !== undefined;

      if (!active) {
        setState(null);
        if (document.title !== BASE_TITLE) document.title = BASE_TITLE;
        return;
      }

      let label = t("downloadBadgeWaiting");
      if (freshFailed !== undefined) {
        label = t("downloadBadgeFailed");
      }
      if (downloading !== undefined) {
        const pct =
          downloading.expectedSize !== null && downloading.expectedSize > 0
            ? Math.min(
                100,
                Math.round((downloading.downloadedBytes / downloading.expectedSize) * 100),
              )
            : null;
        label = pct !== null ? `${pct}%` : t("downloadBadgeIndeterminate");
        document.title = `${pct !== null ? `${pct}% · ` : ""}${downloading.model} — ${BASE_TITLE}`;
      } else {
        document.title = BASE_TITLE;
      }
      if (queued > 0 && freshFailed === undefined) label = `${label} +${queued}`;

      setState({
        kind: "active",
        label,
        title: downloading !== undefined ? downloading.model : t("downloadBadgeWaiting"),
        failed: freshFailed !== undefined,
      });
    }

    const unsubscribe = subscribeStream("/api/v1/downloads/stream", {
      onData: (raw) => {
        try {
          const msg = JSON.parse(raw) as TasksMessage;
          if (msg.type === "tasks" && Array.isArray(msg.tasks)) onTasks(msg.tasks);
        } catch {
          // 非 JSON 帧忽略（防御）
        }
      },
    });
    return unsubscribe;
  }, [t, td]);

  if (state === null) return null;

  return (
    <Link
      href="/downloads"
      title={state.title}
      aria-label={t("downloadBadgeAria")}
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-md border px-2 font-mono text-[11px] tabular-nums",
        state.failed
          ? "border-accent-red/25 bg-accent-red/10 text-accent-red"
          : "border-primary/25 bg-primary/10 text-primary",
      )}
    >
      {state.failed ? (
        <TriangleAlert className="size-3!" />
      ) : (
        <Download className="size-3!" />
      )}
      {state.label}
    </Link>
  );
}
