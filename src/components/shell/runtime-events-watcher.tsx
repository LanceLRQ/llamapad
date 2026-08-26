"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";

import { toast } from "@/components/toast-store";
import { subscribeStream } from "@/lib/shared-event-source";
import { diagnoseStartFailure } from "@/lib/start-advice";

/**
 * 运行时事件监听（UX P0 Task 9 / U3）：面板 layout 挂一次，消费
 * /api/v1/events/stream，把"坏消息"翻译成 toast——
 * - model.exit（M4 迟退检测）：容器异常消失（如启动 ~60s 后 OOM 崩溃），
 *   用户在任何页面都能立刻知道，而不是下次刷新才发现"没在跑了"；
 * - model.start_failed：非浮层路径发起的启动失败（如向导/脚本）兜底。
 *
 * 去重：首帧 snapshot 只建水位（seen 集合），不为历史事件弹toast；
 * 重连后的 snapshot 对已见 id 静默。与概览事件卡经 subscribeStream
 * 共享同一条连接（同端点每页一条）。
 */

type EventsMessage =
  | { type: "snapshot"; events: { id: number; kind: string; message: string }[] }
  | { type: "event"; id: number; kind: string; message: string };

function parseMessage(raw: string): EventsMessage | null {
  try {
    const msg = JSON.parse(raw) as { type?: unknown };
    if (msg.type === "snapshot" || msg.type === "event") return msg as EventsMessage;
  } catch {
    // 非 JSON 帧忽略（防御，契约内不应出现）
  }
  return null;
}

export function RuntimeEventsWatcher() {
  const t = useTranslations("pages.startProgress");

  useEffect(() => {
    const seen = new Set<number>();

    function notify(kind: string, message: string): void {
      if (kind === "model.exit" || kind === "model.start_failed") {
        const adviceKind = diagnoseStartFailure(message);
        toast.error(`${message}\n${t(`advice.${adviceKind}`)}`);
      }
    }

    const unsubscribe = subscribeStream("/api/v1/events/stream", {
      onData: (raw) => {
        const msg = parseMessage(raw);
        if (msg === null) return;
        if (msg.type === "snapshot") {
          for (const row of msg.events) seen.add(row.id);
          return;
        }
        if (seen.has(msg.id)) return;
        seen.add(msg.id);
        notify(msg.kind, msg.message);
      },
    });

    return unsubscribe;
  }, [t]);

  return null;
}
