"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  Download,
  Eraser,
  Pause,
  Play,
  SquareTerminal,
  WrapText,
} from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { countMatches, escapeRegExp, filterEntries, normalizeQuery } from "@/lib/log-filter";

/**
 * 实时日志终端（M3 Task 5）：EventSource 消费 /api/v1/logs/stream 的
 * 通用组件（SSE 事件形态见该 route 注释：log 行 + container/waiting 元事件；
 * Last-Event-ID 断线补发由浏览器自动携带）。
 *
 * 暂停语义（简化版）：暂停 = 停止 DOM 更新但缓冲继续收（EventSource 不断、
 * 缓冲照常入列与封顶），恢复时一次性渲染积压——实现简单且不丢单。
 *
 * 自动滚动：贴底（距底 ≤ 40px）时新行跟随滚底；用户上滚即暂停跟随，
 * 右下角浮出"回到底部"按钮，点击恢复跟随。
 *
 * 搜索 / 换行（UX P0 Task 4）：搜索 = 客户端缓冲内大小写不敏感子串过滤 +
 * 高亮（元事件行恒保留，见 log-filter.ts）；换行开关在 break-all 软换行与
 * 横向滚动间切换（长 JSON 行看结构 vs 看全貌两种诉求）。
 *
 * 设计约定（ui-demo monitoring）：终端区双主题恒深色——容器固定项目暗色
 * 令牌（bg #101013 / 前景 #fafafa / 元事件 amber #f59e0b / 弱化 #a1a1aa，
 * 均取自 globals.css .dark 的 --card/--foreground/--primary/--muted-foreground），
 * 不随 next-themes 切换；工具条与浮标仍在主题系统内。
 */

/** 行缓冲上限：超出丢头部并计数提示（只影响客户端，服务端缓冲独立裁剪） */
const MAX_BUFFER_LINES = 1000;

/** 距底不超过该像素值视为"贴底跟随"，超过即暂停自动滚动 */
const FOLLOW_THRESHOLD_PX = 40;

/**
 * 终端渲染条目：log 行 / container 分隔（amber）/ waiting 分隔（弱化）/
 * history 分隔（弱化，标记其上方为面板重启前落盘回灌的日志）
 */
interface TerminalEntry {
  key: number;
  kind: "log" | "container" | "waiting" | "history";
  text: string;
}

/** SSE data 帧的判别联合（与 logsStream.ts 的 send 载荷对应） */
type StreamMessage =
  | { type: "log"; line: string }
  | { type: "container"; name: string }
  | { type: "waiting" }
  | { type: "history"; lines: string[] };

function parseMessage(raw: string): StreamMessage | null {
  try {
    const msg = JSON.parse(raw) as {
      type?: unknown;
      line?: unknown;
      name?: unknown;
      lines?: unknown;
    };
    if (msg.type === "log" && typeof msg.line === "string") return { type: "log", line: msg.line };
    if (msg.type === "container" && typeof msg.name === "string")
      return { type: "container", name: msg.name };
    if (msg.type === "waiting") return { type: "waiting" };
    if (msg.type === "history" && Array.isArray(msg.lines))
      return { type: "history", lines: msg.lines.filter((l): l is string => typeof l === "string") };
  } catch {
    // 非 JSON 帧直接丢弃（服务端契约内不应出现，防御即可）
  }
  return null;
}

/** 导出文件名时间戳：YYYYMMDD-HHmmss（本地时区，用户可读优先） */
function fileTimestamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

/** 搜索命中高亮：按字面量子串切分，命中段 amber 底标记（仅深色终端区内使用） */
function renderHighlighted(text: string, query: string): ReactNode {
  const needle = normalizeQuery(query);
  if (needle === null) return text;
  const parts = text.split(new RegExp(`(${escapeRegExp(needle)})`, "gi"));
  if (parts.length === 1) return text;
  const lower = needle.toLowerCase();
  return parts.map((part, index) =>
    part.toLowerCase() === lower ? (
      <mark key={index} className="rounded-sm bg-amber-500/40 px-0.5 text-inherit">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

export function LogTerminal({
  streamUrl,
  /** 滚动体尺寸（高度/最大高度）由使用方给：监控页 60vh */
  bodyClassName,
  /** 撑满父级 flex 容器剩余高度（监控页日志分组独占屏幕时用）：根节点与
   * 滚动体外层原本都不带 flex-1，光让父级 flex 撑不满，需要这三处一起补齐 */
  fill,
}: {
  streamUrl: string;
  bodyClassName?: string;
  fill?: boolean;
}) {
  const t = useTranslations("terminal");

  // ---- 缓冲与渲染（真相在 ref；state 只做渲染快照）----
  const bufferRef = useRef<TerminalEntry[]>([]);
  const keySeqRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const [entries, setEntries] = useState<TerminalEntry[]>([]);
  /** 因超限被丢弃的头部行数（累计；清屏归零） */
  const [dropped, setDropped] = useState(0);

  // ---- 跟随 / 暂停 / 连接 ----
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const pausedRef = useRef(false);
  const [following, setFollowing] = useState(true);
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState(false);
  const [container, setContainer] = useState<string | null>(null);
  // ---- 搜索 / 换行（UX P0 Task 4）----
  const [query, setQuery] = useState("");
  const [wrap, setWrap] = useState(true);

  /** 把缓冲刷进渲染（rAF 合帧：突发多行也只渲一帧） */
  const flush = useCallback(() => {
    setEntries(bufferRef.current.slice());
  }, []);

  const scheduleFlush = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      flush();
    });
  }, [flush]);

  const push = useCallback(
    (kind: TerminalEntry["kind"], text: string) => {
      const buffer = bufferRef.current;
      buffer.push({ key: ++keySeqRef.current, kind, text });
      if (buffer.length > MAX_BUFFER_LINES) {
        const drop = buffer.length - MAX_BUFFER_LINES;
        buffer.splice(0, drop);
        setDropped((n) => n + drop);
      }
      if (!pausedRef.current) scheduleFlush();
    },
    [scheduleFlush],
  );

  // ---- SSE：行事件 append，元事件渲染分隔行（样式区分）----
  useEffect(() => {
    const source = new EventSource(streamUrl);
    source.onopen = () => setConnected(true);
    // 断线：浏览器自动带 Last-Event-ID 重连（服务端补发缓冲存量），这里只更新指示
    source.onerror = () => setConnected(false);
    source.onmessage = (event) => {
      const msg = parseMessage(event.data);
      if (msg === null) return;
      if (msg.type === "log") {
        push("log", msg.line);
      } else if (msg.type === "container") {
        setContainer(msg.name);
        push("container", t("containerLine", { name: msg.name }));
      } else if (msg.type === "history") {
        // 历史行先入缓冲，分隔线随后——读作「以上为重启前的日志」，与实时行划清界限
        for (const line of msg.lines) push("log", line);
        push("history", t("historyLine", { count: msg.lines.length }));
      } else {
        setContainer(null);
        push("waiting", t("waitingLine"));
      }
    };
    return () => source.close();
  }, [streamUrl, push, t]);

  // 贴底跟随：新行渲染后滚到底（用户已上滚则不动）
  useEffect(() => {
    if (stickRef.current && !pausedRef.current) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [entries]);

  // 卸载时取消挂起的 rAF
  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const stick = distance <= FOLLOW_THRESHOLD_PX;
    stickRef.current = stick;
    setFollowing(stick);
  }, []);

  const togglePause = useCallback(() => {
    const next = !pausedRef.current;
    pausedRef.current = next;
    setPaused(next);
    if (!next) {
      // 恢复：一次性补齐暂停期间的积压；仍贴底则回到最新
      flush();
      if (stickRef.current) {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      }
    }
  }, [flush]);

  const clear = useCallback(() => {
    // 清 DOM 与缓冲计数，不动服务端（EventSource 保持，后续行照常到达）
    bufferRef.current = [];
    setDropped(0);
    setEntries([]);
  }, []);

  const exportLogs = useCallback(() => {
    const text = bufferRef.current.map((entry) => entry.text).join("\n");
    const blob = new Blob([text.length > 0 ? `${text}\n` : ""], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `llamapad-logs-${fileTimestamp(new Date())}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }, []);

  const backToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight; // 触发 scroll 事件自会恢复 following
  }, []);

  // 搜索态派生：可见行 = 过滤结果；命中计数基于全量缓冲
  const searching = normalizeQuery(query) !== null;
  const visible = searching ? filterEntries(entries, query) : entries;
  const matchCount = searching ? countMatches(entries, query) : 0;

  return (
    <div className={cn("flex min-h-0 flex-col", fill && "flex-1")}>
      {/* 工具条：标题 + 连接/容器指示 + 搜索 + 计数 + 四按钮（主题系统内） */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-4 py-2.5">
        <span className="flex items-center gap-1.5 text-xs font-semibold">
          <SquareTerminal className="size-3.5 text-muted-foreground" />
          {t("title")}
        </span>
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span
            className={cn(
              "size-1.5 rounded-full",
              connected ? "bg-accent-green" : "animate-pulse bg-amber-500",
            )}
          />
          {connected ? t("connected") : t("reconnecting")}
        </span>
        {container !== null && (
          <span className="max-w-56 truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px]">
            {container}
          </span>
        )}
        <div className="flex-1" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQuery("");
          }}
          placeholder={t("searchPlaceholder")}
          aria-label={t("searchPlaceholder")}
          className="h-7 w-44 rounded-md text-xs"
        />
        {searching && (
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {t("searchMatches", { count: matchCount })}
          </span>
        )}
        {dropped > 0 && (
          <span className="text-[11px] text-amber-600 dark:text-amber-400">
            {t("droppedLines", { count: dropped })}
          </span>
        )}
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {t("lineCount", { count: entries.length })}
        </span>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant={wrap ? "ghost" : "outline"}
            aria-pressed={wrap}
            aria-label={wrap ? t("wrapOn") : t("wrapOff")}
            title={wrap ? t("wrapOn") : t("wrapOff")}
            onClick={() => setWrap((w) => !w)}
          >
            <WrapText className="size-3.5" />
          </Button>
          <Button size="sm" variant="ghost" onClick={togglePause}>
            {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
            {paused ? t("resume") : t("pause")}
          </Button>
          <Button size="sm" variant="ghost" onClick={clear}>
            <Eraser className="size-3.5" />
            {t("clear")}
          </Button>
          <Button size="sm" variant="ghost" onClick={exportLogs}>
            <Download className="size-3.5" />
            {t("export")}
          </Button>
        </div>
      </div>

      {/* 滚动体：设计约定恒深色（见文件头），bg/前景/元事件色锚定不随主题 */}
      <div className={cn("relative", fill && "min-h-0 flex-1")}>
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className={cn(
            "overflow-y-auto bg-[#101013] px-4 py-3 font-mono text-xs leading-relaxed text-[#fafafa]",
            wrap ? "break-all" : "overflow-x-auto whitespace-pre",
            fill && "h-full",
            bodyClassName,
          )}
        >
          {visible.length === 0 ? (
            <p className="text-[#a1a1aa]">
              {searching ? t("searchNoMatches") : t("emptyHint")}
            </p>
          ) : (
            visible.map((entry) =>
              entry.kind === "log" ? (
                <div key={entry.key} className="whitespace-pre-wrap break-all">
                  {renderHighlighted(entry.text, query)}
                </div>
              ) : (
                <div
                  key={entry.key}
                  className={cn(
                    "my-1 truncate",
                    entry.kind === "container"
                      ? "font-medium text-[#f59e0b]"
                      : "text-[#a1a1aa] italic",
                  )}
                  title={entry.text}
                >
                  {entry.kind === "container" || entry.kind === "history"
                    ? `── ${entry.text} ──`
                    : `· ${entry.text}`}
                </div>
              ),
            )
          )}
        </div>

        {/* 回到底部浮标：上滚脱离贴底时出现 */}
        {!following && (
          <button
            type="button"
            onClick={backToBottom}
            className="absolute right-4 bottom-3 flex h-7 items-center gap-1.5 rounded-md bg-[#18181b] px-2.5 text-xs text-[#fafafa] shadow-lg ring-1 ring-white/10 select-none hover:bg-[#242428]"
          >
            <ArrowDown className="size-3.5" />
            {t("backToBottom")}
          </button>
        )}
      </div>
    </div>
  );
}
