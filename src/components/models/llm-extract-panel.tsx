"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Sparkles, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";

import type { ServerConfig } from "@/core/schemas";
import { RecommendProfileCard } from "@/components/models/recommend-profile-card";
import { Button } from "@/components/ui/button";
import { LineSplitter } from "@/core/line-splitter";
import { apiFetch } from "@/lib/api";
import type { RecommendedProfile } from "@/lib/readme-params";

/**
 * AI 解析面板（批 3）
 *
 * **没有任何自动路径通向请求**：进页面、切 tab 都不发。只有点「开始解析 /
 * 重新解析」才发——外部 API 每次调用都花钱，"顺手跑一下"意味着用户只是想
 * 看看这个 tab 长什么样就产生了消费。
 *
 * 流式帧是面板自己的协议（`{type:"delta"|"done"|"error"}`），不是 provider 的——
 * 服务端已经解析过一遍 OpenAI 帧了，前端不该再解析一次。
 */

interface EngineState {
  engine: "none" | "local" | "external";
  externalReady: boolean;
  missing: string[];
  hasRunningModel: boolean;
}

type Phase =
  | { kind: "idle" }
  | { kind: "streaming"; text: string }
  | { kind: "error"; message: string };

/** 引擎不可用的三种原因，各自有独立的话要说 */
function describeUnavailable(state: EngineState | null): "disabled" | "incomplete" | "noModel" | null {
  if (state === null) return null;
  if (state.engine === "none") return "disabled";
  if (state.engine === "external" && !state.externalReady) return "incomplete";
  if (state.engine === "local" && !state.hasRunningModel) return "noModel";
  return null;
}

/** 流内 error 帧的 kind → i18n 键的显式映射。模板字面量键（`llmError.${kind}`）
 *  会被部分 lint 配置拒绝；显式映射还顺带兜底了后端加了新 kind、前端未跟上的
 *  情形——落到 network 兜底文案而不是渲染出一个原始键名 */
const ERROR_KEY: Record<string, string> = {
  notConfigured: "llmError.notConfigured",
  noRunningModel: "llmError.noRunningModel",
  unauthorized: "llmError.unauthorized",
  rateLimited: "llmError.rateLimited",
  network: "llmError.network",
  badResponse: "llmError.badResponse",
};

export function LlmExtractPanel({ repoId, effective, repoBaseName, cached, onApply, onSaveAsPreset }: {
  repoId: number;
  effective: ServerConfig;
  repoBaseName: string;
  cached: { profiles: unknown[]; model: string | null; parsedAt: number | null; stale: boolean } | null;
  onApply: (profileId: string, server: Partial<ServerConfig>) => void;
  onSaveAsPreset: (server: Partial<ServerConfig>, name: string) => void;
}) {
  const t = useTranslations("pages.repos");
  const [engineState, setEngineState] = useState<EngineState | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [profiles, setProfiles] = useState<RecommendedProfile[]>(
    () => (cached?.profiles ?? []) as RecommendedProfile[],
  );
  const [stats, setStats] = useState<{ offered: number; dropped: number } | null>(null);
  // 重跑覆盖对比弹层（任务 16）尚未接入本文件，这里先把状态占位留好——
  // `pendingOverwrite` 现在只写不读，任务 16 接的就是这个名字的状态
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [pendingOverwrite, setPendingOverwrite] = useState<{
    raw: string; engine: string; model: string; profiles: RecommendedProfile[];
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  // 引擎状态只读一次配置，不发任何 LLM 请求
  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await apiFetch("/api/v1/settings/llm").catch(() => null);
      if (!alive || res === null || !res.ok) return;
      // 一次请求拿全：GET /api/v1/settings/llm 顺带回了 hasRunningModel（任务 12）
      const s = (await res.json()) as EngineState;
      setEngineState(s);
    })();
    return () => { alive = false; };
  }, []);

  async function start(): Promise<void> {
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase({ kind: "streaming", text: "" });
    setStats(null);

    try {
      const res = await apiFetch(`/api/v1/repos/${repoId}/readme/llm`, {
        method: "POST",
        signal: controller.signal,
      });
      if (!res.ok || res.body === null) throw new Error(`HTTP ${res.status}`);

      let acc = "";
      const splitter = new LineSplitter((line) => {
        if (!line.startsWith("data: ")) return;
        const frame = JSON.parse(line.slice(6)) as Record<string, unknown>;

        if (frame.type === "delta" && frame.kind === "content") {
          acc += String(frame.text);
          setPhase({ kind: "streaming", text: acc });
        } else if (frame.type === "error") {
          const key = ERROR_KEY[String(frame.kind)] ?? ERROR_KEY.network;
          setPhase({ kind: "error", message: t(key) });
        } else if (frame.type === "done") {
          const result = frame.result as { profiles: RecommendedProfile[]; offered: number; dropped: number };
          setStats({ offered: result.offered, dropped: result.dropped });
          if (frame.hadPrevious === true) {
            setPendingOverwrite({
              raw: String(frame.raw),
              engine: String(frame.engine),
              model: String(frame.model),
              profiles: result.profiles,
            });
          } else {
            setProfiles(result.profiles);
          }
          setPhase({ kind: "idle" });
        }
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        splitter.push(decoder.decode(value, { stream: true }));
      }
      splitter.flush();
    } catch {
      if (!controller.signal.aborted) setPhase({ kind: "error", message: t("llmError.network") });
      else setPhase({ kind: "idle" });
    } finally {
      abortRef.current = null;
    }
  }

  // 流式时自动滚底
  useEffect(() => {
    if (phase.kind === "streaming" && logRef.current !== null) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [phase]);

  const unavailable = describeUnavailable(engineState);

  if (unavailable === "disabled") {
    return (
      <Notice text={t("llmDisabled")} action={{ href: "/settings?tab=runtime", label: t("llmGoSettings") }} />
    );
  }
  if (unavailable === "incomplete") {
    return (
      <Notice
        text={t("llmIncomplete", { fields: (engineState?.missing ?? []).map((m) => t(`llmField.${m}`)).join("、") })}
        action={{ href: "/settings?tab=runtime", label: t("llmGoSettings") }}
      />
    );
  }
  if (unavailable === "noModel") {
    return <Notice text={t("llmNoRunningModel")} action={{ href: "/models", label: t("llmGoModels") }} />;
  }

  if (phase.kind === "streaming") {
    return (
      <div className="flex flex-col gap-3">
        <div ref={logRef} className="max-h-48 overflow-y-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap">
          {phase.text === "" ? t("llmWaiting") : phase.text}
        </div>
        <Button size="sm" variant="outline" className="self-end" onClick={() => abortRef.current?.abort()}>
          {t("llmCancel")}
        </Button>
      </div>
    );
  }

  if (profiles.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm text-muted-foreground">
          {stats === null ? t("llmIntro") : t("llmFoundNothing")}
        </p>
        {phase.kind === "error" && <p className="text-xs text-destructive">{phase.message}</p>}
        <Button size="sm" onClick={() => void start()}>
          <Sparkles className="size-3.5" />
          {stats === null ? t("llmStart") : t("llmRerun")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {cached?.stale === true && <p className="text-xs text-muted-foreground">{t("llmStale")}</p>}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {profiles.map((profile) => (
          <RecommendProfileCard
            key={profile.id}
            profile={profile}
            effective={effective}
            repoBaseName={repoBaseName}
            onApply={(server) => onApply(profile.id, server)}
            onSaveAsPreset={onSaveAsPreset}
          />
        ))}
      </div>
      {stats !== null && stats.dropped > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("llmDropped", { offered: stats.offered, dropped: stats.dropped })}
        </p>
      )}
      {phase.kind === "error" && <p className="text-xs text-destructive">{phase.message}</p>}
      <Button size="sm" variant="outline" className="self-end" onClick={() => void start()}>
        {t("llmRerun")}
      </Button>
    </div>
  );
}

/** 不可用 / 未跑过入口提示：图标 + 一句话 + 一个出口按钮，形态照
 *  readme-view.tsx 里 readmeUnauthorizedTitle 那块——本仓 Button 是 Base UI
 *  形态，没有 asChild，跳转用 render={<Link/>} */
function Notice({ text, action }: { text: string; action: { href: string; label: string } }) {
  return (
    <div className="flex flex-col items-start gap-3">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <TriangleAlert className="size-4" />
        {text}
      </div>
      <Button size="sm" variant="outline" nativeButton={false} render={<Link href={action.href} />}>
        {action.label}
      </Button>
    </div>
  );
}
