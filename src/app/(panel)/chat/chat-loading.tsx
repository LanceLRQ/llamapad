"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Card, CardContent } from "@/components/ui/card";
import { apiFetch } from "@/lib/api";

/**
 * Chat 页加载态（真机缺陷修复：容器起来 ≠ llama-server 已监听，见
 * server/readiness.ts 头注释）：running 存在但 ready 为 false 时的过渡卡片，
 * 顶在引导卡与 ChatFrame 之间（见 chat/page.tsx 的三分支）。
 *
 * 每 2s 轮询运行状态，ready 翻真即 router.refresh()——服务端组件重新渲染，
 * 三分支自然换成 ChatFrame，本组件无需自己持有"何时切走"的状态。轮询节拍
 * （visibility 暂停 + 回到可见立即补拉）与 monitoring/run-history.tsx、
 * monitoring/metric-cards.tsx 同款。
 */
const POLL_MS = 2_000;

interface RuntimeStatusResponse {
  running: { ready: boolean } | null;
}

export function ChatLoading() {
  const t = useTranslations("pages.chat");
  const router = useRouter();
  const [elapsed, setElapsed] = useState(0);

  const poll = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await apiFetch("/api/v1/runtime/status", { signal, cache: "no-store" });
        if (!res.ok) return;
        const status = (await res.json()) as RuntimeStatusResponse;
        if (status.running?.ready === true) router.refresh();
      } catch (error) {
        if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
          return;
        }
        // 轮询失败静默：这里只管"翻绿就刷新"，断线提示已由状态栏承担
      }
    },
    [router],
  );

  useEffect(() => {
    const controller = new AbortController();
    const tick = () => {
      if (!document.hidden) void poll(controller.signal);
    };
    const timer = setInterval(tick, POLL_MS);
    tick();
    const onVisibility = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      controller.abort();
    };
  }, [poll]);

  // 已等待秒数：纯展示，独立计时，不跟随轮询节拍
  useEffect(() => {
    const startedAt = Date.now();
    const timer = setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, []);

  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <Loader2 className="size-6 animate-spin" />
        </span>
        <p className="text-sm font-medium">{t("loadingTitle")}</p>
        <p className="max-w-md text-sm text-muted-foreground">{t("loadingHint")}</p>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">{elapsed}s</span>
      </CardContent>
    </Card>
  );
}
