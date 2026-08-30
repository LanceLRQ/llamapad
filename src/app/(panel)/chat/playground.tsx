"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Send, Square, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "@/components/markdown";
import { LineSplitter } from "@/core/line-splitter";
import { apiFetch } from "@/lib/api";
import { buildChatBody, isSendable, type ChatTurn } from "@/lib/chat-request";
import { parseSseLine, type ChatTimings } from "@/lib/chat-stream";

const ENDPOINT = "/api/v1/proxy/llama/v1/chat/completions";
/** 流式提交节流：20+ tok/s 下每 token 重建 markdown AST 会卡，80ms 一批肉眼仍连续 */
const FLUSH_MS = 80;

interface LiveTurn {
  content: string;
  reasoning: string;
}

export function Playground({ onBodyChange }: { onBodyChange?: (body: unknown) => void }) {
  const t = useTranslations("pages.chat");
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timings, setTimings] = useState<ChatTimings | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 同步重入闸门：state 提交有延迟，双击/连击 Enter 挤在同一次 setStreaming(true)
  // 落地之前时，两次调用读到的 streaming 闭包值都还是 false；ref 写入是同步的，没有这个窗口
  const streamingRef = useRef(false);

  const send = useCallback(async () => {
    if (!isSendable(input, streaming)) return;
    if (streamingRef.current) return;
    streamingRef.current = true;
    const text = input.trim();
    const body = buildChatBody(history, text);
    onBodyChange?.(body);

    setHistory((h) => [...h, { role: "user", content: text, reasoning: "" }]);
    setInput("");
    setError(null);
    setTimings(null);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;
    // 累加器放 ref 之外的局部量：节流提交只读它，不参与 React 状态更新竞态
    const acc: LiveTurn = { content: "", reasoning: "" };
    let lastFlush = 0;
    const flush = (force: boolean) => {
      const now = Date.now();
      if (!force && now - lastFlush < FLUSH_MS) return;
      lastFlush = now;
      setLive({ ...acc });
    };

    try {
      const res = await apiFetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok || res.body === null) {
        // 原样展示上游报文：错误被吞掉是这次改造要解决的问题之一
        setError(`HTTP ${res.status}\n${await res.text()}`);
        return;
      }

      const decoder = new TextDecoder();
      const splitter = new LineSplitter((line) => {
        for (const ev of parseSseLine(line)) {
          if (ev.type === "content") acc.content += ev.text;
          else if (ev.type === "reasoning") acc.reasoning += ev.text;
          else if (ev.type === "done") setTimings(ev.timings);
          else if (ev.type === "error") setError(ev.message);
        }
        flush(false);
      });

      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        splitter.push(decoder.decode(value, { stream: true }));
      }
      splitter.flush();
    } catch (e) {
      // abort 是用户主动停止，不是错误：已生成的部分照常落进历史
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      abortRef.current = null;
      streamingRef.current = false;
      setStreaming(false);
      setLive(null);
      if (acc.content !== "" || acc.reasoning !== "") {
        setHistory((h) => [...h, { role: "assistant", ...acc }]);
      }
    }
  }, [history, input, streaming, onBodyChange]);

  // 新增消息或流式增量到达时贴底：直接设 scrollTop 而非 scrollIntoView({behavior:"smooth"})，
  // 后者在 80ms 一次的节流下会把动画排成队，反而比瞬时跳更晃
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history, live]);

  // 卸载即中断：切走页面后端仍在生成的话，白烧 GPU 到流自然结束为止
  useEffect(() => () => abortRef.current?.abort(), []);

  function handleClear() {
    setHistory([]);
    setError(null);
    setTimings(null);
    setLive(null);
  }

  const showEmptyHint = history.length === 0 && !streaming;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center justify-end">
        <Button variant="ghost" size="sm" disabled={streaming} onClick={handleClear}>
          <Trash2 className="size-3.5" />
          {t("clear")}
        </Button>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto rounded-lg border p-4">
        {showEmptyHint ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {t("emptyHint")}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {history.map((turn, i) => (
              <MessageBubble key={i} turn={turn} reasoningLabel={t("reasoningLabel")} />
            ))}
            {live !== null && (
              <MessageBubble
                turn={{ role: "assistant", content: live.content, reasoning: live.reasoning }}
                reasoningLabel={t("reasoningLabel")}
              />
            )}
            {timings !== null && (
              <p className="font-mono text-xs tabular-nums text-muted-foreground">
                {timings.predictedN} tok · {timings.predictedPerSecond.toFixed(1)} tok/s ·{" "}
                {Math.round(timings.promptMs)}ms
              </p>
            )}
            {error !== null && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
                <p className="font-medium">{t("errorTitle")}</p>
                <pre className="mt-1 font-mono text-xs whitespace-pre-wrap break-words">{error}</pre>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex items-end gap-2">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // 组词中的 Enter 是"确认候选词"不是"发送"：中文/日文 IME 下不判 isComposing
            // 会把用户打到一半的句子提前发出去。Shift+Enter 换行是原生行为，不拦截
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={t("inputPlaceholder")}
          className="max-h-40"
        />
        {streaming ? (
          <Button variant="outline" onClick={() => abortRef.current?.abort()}>
            <Square className="size-3.5" />
            {t("stop")}
          </Button>
        ) : (
          <Button disabled={!isSendable(input, streaming)} onClick={() => void send()}>
            <Send className="size-3.5" />
            {t("send")}
          </Button>
        )}
      </div>
    </div>
  );
}

/** 单条消息：user 纯文本保留换行，assistant 过 Markdown；reasoning 折叠在正文上方默认收起 */
function MessageBubble({ turn, reasoningLabel }: { turn: ChatTurn; reasoningLabel: string }) {
  if (turn.role === "user") {
    return (
      <div className="ml-auto max-w-[85%] rounded-lg bg-accent px-3 py-2 text-sm whitespace-pre-wrap text-accent-foreground">
        {turn.content}
      </div>
    );
  }
  return (
    <div className="max-w-[85%] rounded-lg border px-3 py-2">
      {turn.reasoning !== "" && (
        <details className="mb-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">{reasoningLabel}</summary>
          <p className="mt-1 whitespace-pre-wrap">{turn.reasoning}</p>
        </details>
      )}
      <Markdown text={turn.content} />
    </div>
  );
}
