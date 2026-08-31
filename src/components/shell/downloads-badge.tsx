"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Download, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";

import { toast } from "@/components/toast-store";
import { cn } from "@/lib/utils";
import { subscribeStream } from "@/lib/shared-event-source";
import {
  BASE_TITLE,
  STATUS_BAR_ITEM_CLASS,
  type DerivedDownloadState,
  type DownloadTaskSnapshot,
  deriveDownloadState,
} from "@/lib/status-bar";

/**
 * 状态栏下载条目（UX P0 Task 10 / U5，M16 T1 改状态栏条目形态）：订阅
 * /api/v1/downloads/stream（1s 快照），让"人在别的页面/后台标签页"也能看见
 * 下载进展——
 * - 条目：下载中显示百分比（未知大小显示"下载中"）、失败变红、点击直达 /downloads；
 * - document.title：下载中改为 "43% · <模型> — llamapad"，空闲恢复；
 * - 完成/失败 toast（按任务状态迁移触发，首帧只建水位不补弹历史）；
 *   若浏览器通知已授权，同时发系统通知（授权入口在下载页）。
 *
 * 连接经 subscribeStream 与下载页视图共享（同端点每页一条，见
 * shared-event-source.ts 头注释的连接上限背景）。
 *
 * 派生计算（label / document.title / failed）已下沉到 lib/status-bar.ts 的
 * deriveDownloadState——vitest 没有 jsdom，组件渲染测不了，纯逻辑单独测。
 * 本组件只负责订阅、toast/通知这类副作用，以及套用派生结果渲染。
 */

type TasksMessage = { type: "tasks"; tasks: DownloadTaskSnapshot[] };

export function DownloadsBadge() {
  const t = useTranslations("statusbar");
  const td = useTranslations("pages.downloads");
  const [state, setState] = useState<DerivedDownloadState | null>(null);
  const previousStatuses = useRef<Map<number, DownloadTaskSnapshot["status"]> | null>(null);

  useEffect(() => {
    function onTasks(tasks: DownloadTaskSnapshot[]): void {
      // ---- 状态迁移 → toast / 系统通知（首帧只建水位）----
      const prev = previousStatuses.current;
      if (prev !== null) {
        for (const task of tasks) {
          const before = prev.get(task.id);
          if (before === undefined || before === task.status) continue;
          if (task.status === "completed") {
            toast.success(td("toastDone", { model: task.label }));
            if (typeof Notification !== "undefined" && Notification.permission === "granted") {
              new Notification(td("notifyDoneTitle"), { body: task.label });
            }
          } else if (task.status === "failed") {
            toast.error(td("toastFailed", { model: task.label }));
            if (typeof Notification !== "undefined" && Notification.permission === "granted") {
              new Notification(td("notifyFailedTitle"), { body: task.label });
            }
          }
        }
      }
      previousStatuses.current = new Map(tasks.map((task) => [task.id, task.status]));

      // ---- 条目与 document.title：纯计算交给 deriveDownloadState ----
      const derived = deriveDownloadState(tasks, Date.now(), {
        waiting: t("downloadBadgeWaiting"),
        failed: t("downloadBadgeFailed"),
        indeterminate: t("downloadBadgeIndeterminate"),
      });
      setState(derived);
      if (derived === null) {
        if (document.title !== BASE_TITLE) document.title = BASE_TITLE;
        return;
      }
      document.title = derived.docTitle;
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
        STATUS_BAR_ITEM_CLASS,
        "gap-1.5 transition-colors hover:bg-accent",
        state.failed ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {state.failed ? (
        <TriangleAlert className="size-3" />
      ) : (
        <Download className="size-3" />
      )}
      <span className={cn("font-semibold", state.failed ? "text-destructive" : "text-primary")}>
        {state.label}
      </span>
      {/* modelName 只在下载中有值——排队/失败态没有单一"当前模型"这个概念，
          title 属性仍保留同一段文案作悬浮提示（见 lib/status-bar.ts 的注释） */}
      {state.modelName !== null && (
        <span className="text-muted-foreground">{state.modelName}</span>
      )}
    </Link>
  );
}
