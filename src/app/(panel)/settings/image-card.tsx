"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { CheckCircle2, Container, Download, Loader2, TriangleAlert, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { apiFetch } from "@/lib/api";
import type { PullSnapshot } from "@/core/pull-progress";

/**
 * 设置页「运行镜像」卡片（UX P1 U14，client）：
 * - 展示当前生效镜像（default_config.docker.image，server 侧装配初值）
 * - 「拉取最新」按钮 → POST /api/v1/images/pull（SSE）：EventSource 不支持
 *   POST，改用 fetch + ReadableStream 手动切帧（按 SSE 规范以 "\n\n" 分帧，
 *   取 "data: " 行 JSON.parse；心跳注释帧 ": ping" 天然不匹配前缀，直接跳过）
 * - percent 为 null（层未汇报体积）时显示 status 文本 + 不确定态动画条，
 *   不显示 NaN/0%（core/pull-progress 的聚合语义见其文件头）
 * - 完成后查一次运行状态：有模型在跑则给出琥珀提示（复用 configStale 同款
 *   风格）——镜像只在下次创建容器时生效，不会让运行中的容器热更新
 */

type PullEvent =
  | ({ type: "progress" } & PullSnapshot)
  | { type: "done" }
  | { type: "error"; message: string };

/** 按 SSE 帧规范（"\n\n" 分隔）解析 response.body，每帧回调一次 */
async function readSse(body: ReadableStream<Uint8Array>, onEvent: (raw: string) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let sep = buffer.indexOf("\n\n");
    while (sep !== -1) {
      onEvent(buffer.slice(0, sep));
      buffer = buffer.slice(sep + 2);
      sep = buffer.indexOf("\n\n");
    }
  }
}

export function ImageCard({ initialImage }: { initialImage: string }) {
  const t = useTranslations("pages.settings.image");
  const tCommon = useTranslations("pages.settings");

  const [pulling, setPulling] = useState(false);
  const [snapshot, setSnapshot] = useState<PullSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [restartHint, setRestartHint] = useState(false);

  async function onPull() {
    if (pulling) return;
    setPulling(true);
    setSnapshot(null);
    setError(null);
    setDone(false);
    setRestartHint(false);

    const res = await apiFetch("/api/v1/images/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }).catch(() => null);

    if (res === null) {
      setError(tCommon("errorNetwork"));
      setPulling(false);
      return;
    }
    if (!res.ok || res.body === null) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(data?.error ?? tCommon("errorRequest"));
      setPulling(false);
      return;
    }

    try {
      await readSse(res.body, (rawEvent) => {
        const dataLine = rawEvent.split("\n").find((line) => line.startsWith("data: "));
        if (!dataLine) return; // 心跳注释帧（": ping"）等非 data 帧跳过
        const msg = JSON.parse(dataLine.slice("data: ".length)) as PullEvent;
        if (msg.type === "progress") setSnapshot(msg);
        else if (msg.type === "error") setError(msg.message);
        else if (msg.type === "done") setDone(true);
      });
    } catch {
      setError(tCommon("errorNetwork"));
    }
    setPulling(false);

    // 拉取完成（成功/失败均可能有部分进度）：查一次当前是否有模型在跑，
    // 决定要不要给"重启后生效"提示——镜像热更新对已起的容器不生效
    const statusRes = await apiFetch("/api/v1/runtime/status", { cache: "no-store" }).catch(() => null);
    if (statusRes?.ok) {
      const status = (await statusRes.json()) as { running: { model: string } | null };
      setRestartHint(status.running !== null);
    }
  }

  const percent = snapshot?.percent ?? null;

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2.5 border-b px-4 py-3">
        <Container className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{t("title")}</h2>
        <span className="text-xs text-muted-foreground">{t("description")}</span>
      </div>

      <div className="flex flex-col gap-3 px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="min-w-0 truncate font-mono text-sm">{initialImage}</span>
          <Button size="sm" disabled={pulling} onClick={onPull}>
            {pulling ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
            {pulling ? t("pulling") : t("pullButton")}
          </Button>
        </div>

        {pulling && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-3">
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                {percent !== null ? (
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-500"
                    style={{ width: `${Math.max(3, percent)}%` }}
                  />
                ) : (
                  <div className="h-full w-full animate-pulse rounded-full bg-primary/40" />
                )}
              </div>
              {percent !== null && (
                <span className="font-mono text-xs tabular-nums text-muted-foreground">{percent}%</span>
              )}
            </div>
            <span className="text-xs text-muted-foreground">{snapshot?.status ?? t("pullStarting")}</span>
          </div>
        )}

        {error && (
          <p className="flex items-center gap-1.5 text-xs text-destructive">
            <XCircle className="size-3.5 shrink-0" />
            {t("pullFail", { error })}
          </p>
        )}

        {done && !error && (
          <p className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="size-3.5 shrink-0" />
            {t("pullDone")}
          </p>
        )}

        {done && !error && restartHint && (
          <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-700 dark:text-amber-400">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span>{t("pullRestartHint")}</span>
          </div>
        )}
      </div>
    </Card>
  );
}
