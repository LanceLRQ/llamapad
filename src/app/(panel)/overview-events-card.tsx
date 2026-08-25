"use client";

import { useEffect, useMemo, useState } from "react";
import { ScrollText } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { Card, CardContent } from "@/components/ui/card";

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

/** 事件 kind → 圆点色：start 绿 / stop 灰 / update amber / delete 与 start_failed 红（M1 样式不变） */
const EVENT_DOT_CLASS: Record<string, string> = {
  "model.start": "bg-accent-green",
  "model.stop": "bg-muted-foreground/40",
  "model.update": "bg-amber-500",
  "model.delete": "bg-accent-red",
  "model.start_failed": "bg-accent-red",
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
    const es = new EventSource("/api/v1/events/stream");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false); // 自动重连中（或已 CLOSED——提示文案两者通用）
    es.onmessage = (ev) => {
      const msg = parseMessage(ev.data);
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
    };
    return () => es.close();
  }, []);

  return (
    <Card>
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <ScrollText className="size-3.5 text-muted-foreground" />
          <span className="text-xs font-semibold">{t("eventsTitle")}</span>
          {!connected && (
            <span className="ml-auto text-[11px] text-muted-foreground/70">{t("eventsReconnecting")}</span>
          )}
        </div>

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

        <p className="text-[11px] text-muted-foreground">{t("eventsRecentOnly")}</p>
      </CardContent>
    </Card>
  );
}
