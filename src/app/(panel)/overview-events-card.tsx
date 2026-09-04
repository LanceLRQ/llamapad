"use client";

import { useEffect, useMemo, useState } from "react";
import { ScrollText } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { Card, CardContent } from "@/components/ui/card";
import { subscribeStream } from "@/lib/shared-event-source";

/**
 * 概览事件流卡（client，M3 Task 7）：EventSource("/api/v1/events/stream") 实时化。
 *
 * - snapshot 消息幂等替换整表（SSR 初始数据 / 断线重连后的快照都走这条路）
 * - event 增量 prepend（新事件在最上），客户端保留上限 200 行防长连接无限增长
 * - 断线：EventSource 浏览器默认自动重连（不发自定义 retry，默认 ~3s），
 *   断开期间显示一行"重连中"提示；重连成功由下一帧 snapshot 自动对齐
 *
 * 页面不可见不特殊处理：服务端是 2s 轻查询（单表主键水位比较），后台标签页
 * 维持连接的成本远低于下载页 1s 快照的量级，不值得引入 visibilitychange
 * 开关连接的重连抖动。
 *
 * 时间格式化：useLocale + Intl.DateTimeFormat（与原 server 渲染同参数），
 * useMemo 缓存实例；列表只增不改，重渲染开销可忽略。
 */

/** events 表行（与 GET /api/v1/events 响应行 / SSE 增量帧字段一致） */
export interface EventRow {
  id: number;
  ts: number;
  kind: string;
  message: string;
}

/** 客户端保留行数上限（snapshot 20 条起，长连接增量 prepend 的截断线） */
const MAX_ROWS = 200;

/** 事件 kind → 圆点色：model.*（M1 样式不变）+ auth.* 审计线（U23，蓝=常规、红=危险）
 *  + download.*（既有事件此前无配色一直灰点，顺带补齐） */
const EVENT_DOT_CLASS: Record<string, string> = {
  "model.start": "bg-accent-green",
  "model.stop": "bg-muted-foreground/40",
  "model.update": "bg-amber-500",
  "model.delete": "bg-accent-red",
  "model.start_failed": "bg-accent-red",
  "auth.login": "bg-sky-500",
  "auth.logout": "bg-muted-foreground/40",
  "auth.setup": "bg-sky-500",
  "auth.token_issue": "bg-sky-500",
  "auth.token_revoke": "bg-accent-red",
  "auth.login_failed": "bg-accent-red",
  "download.enqueue": "bg-muted-foreground/40",
  "download.complete": "bg-accent-green",
  "download.failed": "bg-accent-red",
  "download.queue_stalled": "bg-amber-500",
  "acquire.glob_extension": "bg-amber-500",
};

/** SSE data 帧的判别联合：snapshot（整表替换）与 event（单条增量） */
type EventsMessage = { type: "snapshot"; events: EventRow[] } | ({ type: "event" } & EventRow);

function parseMessage(raw: string): EventsMessage | null {
  try {
    const parsed = JSON.parse(raw) as EventsMessage;
    if (parsed?.type === "snapshot" && Array.isArray(parsed.events)) return parsed;
    if (parsed?.type === "event" && typeof parsed.id === "number") return parsed;
    return null;
  } catch {
    return null; // 半截帧（JSON.parse 失败）：丢弃等下一帧，EventSource 分帧保证完整帧到达
  }
}

export function OverviewEventsCard({ initialEvents }: { initialEvents: EventRow[] }) {
  const t = useTranslations("pages.overview");
  const locale = useLocale();
  const [events, setEvents] = useState<EventRow[]>(initialEvents);
  /** 连接健康：初始视为正常（SSR 数据可用），onopen 复位 / onerror 置灰提示 */
  const [connected, setConnected] = useState(true);
  const eventFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
    [locale],
  );

  useEffect(() => {
    // 共享连接（UX P0 走查修复）：与 layout 的 RuntimeEventsWatcher 同订本端点，
    // 每页一条；连接态经 onStateChange 注册回放 + 迁移通知
    const unsubscribe = subscribeStream("/api/v1/events/stream", {
      onStateChange: (open) => setConnected(open), // 自动重连中（或已 CLOSED——提示文案两者通用）
      onData: (raw) => {
        const msg = parseMessage(raw);
        if (msg === null) return;
        if (msg.type === "snapshot") {
          setEvents(msg.events);
          return;
        }
        // 增量 prepend：升序到达逐条前插，最新恒在最上；去重（重连窗口的理论重放）兜底
        setEvents((prev) => {
          if (prev.length > 0 && msg.id >= prev[0].id) return prev; // 已见过（快照水位内的迟到帧）
          return [msg, ...prev].slice(0, MAX_ROWS);
        });
      },
    });
    return unsubscribe;
  }, []);

  return (
    // lg:min-h-0 lg:flex-1：右列（page.tsx）在 lg 起是定高列，事件卡是列里
    // 唯一该长满剩余空间、自己滚动的卡（反馈 6）；Card 自带 overflow-hidden，
    // 作为 flex 子项必须显式 min-h-0，否则自动最小尺寸算成 0，卡会被压扁
    // 裁掉内容（page.tsx 右列注释踩过的同一个坑）。lg 以下不设，窄屏整页滚动
    <Card className="lg:min-h-0 lg:flex-1">
      <CardContent className="flex flex-col gap-2 lg:min-h-0 lg:flex-1">
        <div className="flex items-center gap-2">
          <ScrollText className="size-3.5 text-muted-foreground" />
          <span className="text-xs font-semibold">{t("eventsTitle")}</span>
          {!connected && (
            <span className="ml-auto text-[11px] text-muted-foreground/70">{t("eventsReconnecting")}</span>
          )}
        </div>

        {/* 标题行与底部 eventsRecentOnly 留在滚动区外，只有列表本身滚动 */}
        <div className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
          {events.length > 0 ? (
            <ul className="flex flex-col">
              {events.map((event) => (
                <li
                  key={event.id}
                  className="flex items-start gap-2.5 border-b py-2 text-xs last:border-b-0"
                >
                  <span
                    className={`mt-1 size-1.5 shrink-0 rounded-full ${EVENT_DOT_CLASS[event.kind] ?? "bg-muted-foreground/40"}`}
                  />
                  <span className="w-[72px] shrink-0 font-mono tabular-nums text-muted-foreground">
                    {eventFmt.format(new Date(event.ts))}
                  </span>
                  <span className="min-w-0 flex-1 break-words">{event.message}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-4 text-center text-xs text-muted-foreground">{t("eventsEmpty")}</p>
          )}
        </div>

        <p className="text-[11px] text-muted-foreground">{t("eventsRecentOnly")}</p>
      </CardContent>
    </Card>
  );
}
