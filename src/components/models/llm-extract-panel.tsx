"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Sparkles, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";

import type { ServerConfig } from "@/core/schemas";
import { LlmDiffDialog } from "@/components/models/llm-diff-dialog";
import { RecommendProfileCard } from "@/components/models/recommend-profile-card";
import { Button } from "@/components/ui/button";
import { LineSplitter } from "@/core/line-splitter";
import { apiFetch } from "@/lib/api";
import { describeUnavailable, type LlmEngineState } from "@/lib/llm-availability";
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

type Phase =
  | { kind: "idle" }
  | { kind: "streaming"; text: string }
  | { kind: "error"; message: string };

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
  const [engineState, setEngineState] = useState<LlmEngineState | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [profiles, setProfiles] = useState<RecommendedProfile[]>(
    () => (cached?.profiles ?? []) as RecommendedProfile[],
  );
  const [stats, setStats] = useState<{ offered: number; dropped: number } | null>(null);
  /** 本次跑出来的模型名。cached.model 只覆盖「刷新页面后」那条路径，
   *  首次落库这次跑的模型名不记下来就显示不出来 */
  const [runModel, setRunModel] = useState<string | null>(null);
  // 重跑覆盖对比弹层（任务 16）：`done` 帧在 hadPrevious 分支写入这里，
  // LlmDiffDialog 读它决定是否弹出。offered/dropped 额外带在这里（LlmDiffDialog
  // 的 pending 类型不含这两个字段，多传不冲突）——只有用户点「覆盖」才应该被
  // 采纳，在那之前 stats 必须继续显示旧结果对应的计数，见下面 start() 里的注释
  const [pendingOverwrite, setPendingOverwrite] = useState<{
    raw: string; engine: string; model: string; profiles: RecommendedProfile[];
    offered: number; dropped: number;
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
      const s = (await res.json()) as LlmEngineState;
      setEngineState(s);
    })();
    return () => { alive = false; };
  }, []);

  async function start(): Promise<void> {
    const controller = new AbortController();
    abortRef.current = controller;
    // 重跑前的旧计数：hadPrevious 场景要用它把 stats 撑到用户做出选择为止——
    // 卡片内容（profiles）在那之前本就不变，计数不能抢跑，见下方 done 分支
    const priorStats = stats;
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
          // 这次重跑没成功，界面回到重跑前的样子：卡片本来就没动过，
          // 计数也要跟着回去，否则旧卡片还在、它对应的筛选说明却没了
          setStats(priorStats);
          const key = ERROR_KEY[String(frame.kind)] ?? ERROR_KEY.network;
          setPhase({ kind: "error", message: t(key) });
        } else if (frame.type === "done") {
          const result = frame.result as { profiles: RecommendedProfile[]; offered: number; dropped: number };
          if (frame.hadPrevious === true) {
            // 卡片（profiles）在用户选定前不变，计数不能领先于它——撑回重跑前的
            // 旧计数，而不是抢先显示新一次运行的 offered/dropped（时序缺口，见
            // 任务 14/15 报告的遗留疑虑，任务 16 在此闭合）。新计数随 raw 一起
            // 存进 pendingOverwrite，只有覆盖成功才会被 LlmDiffDialog 的
            // onResolved 采纳
            setStats(priorStats);
            setPendingOverwrite({
              raw: String(frame.raw),
              engine: String(frame.engine),
              model: String(frame.model),
              profiles: result.profiles,
              offered: result.offered,
              dropped: result.dropped,
            });
          } else {
            setStats({ offered: result.offered, dropped: result.dropped });
            setProfiles(result.profiles);
            setRunModel(String(frame.model));
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
      // 这次重跑没成功，界面回到重跑前的样子：卡片本来就没动过，
      // 计数也要跟着回去，否则旧卡片还在、它对应的筛选说明却没了
      setStats(priorStats);
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

  // 组件卸载（用户跨路由离开）时掐掉在跑的请求：不 abort 的话服务端收不到
  // 断连信号，本地引擎会继续占着模型槽位、外部 API 继续烧额度，
  // 跑完还会对已卸载的组件 setState
  useEffect(() => () => abortRef.current?.abort(), []);

  const unavailable = describeUnavailable(engineState);

  // 四态渲染收进一个变量，唯一的 return 里连同弹层一起吐出去——弹层要挂在
  // 每一个分支之外，不能让「不可用」这类早返回分支把它带走
  let content: ReactNode;

  if (unavailable === "disabled") {
    content = (
      <Notice text={t("llmDisabled")} action={{ href: "/settings?tab=runtime", label: t("llmGoSettings") }} />
    );
  } else if (unavailable === "incomplete") {
    content = (
      <Notice
        text={t("llmIncomplete", { fields: (engineState?.missing ?? []).map((m) => t(`llmField.${m}`)).join("、") })}
        action={{ href: "/settings?tab=runtime", label: t("llmGoSettings") }}
      />
    );
  } else if (unavailable === "noModel") {
    content = <Notice text={t("llmNoRunningModel")} action={{ href: "/models", label: t("llmGoModels") }} />;
  } else if (phase.kind === "streaming") {
    content = (
      <div className="flex flex-col gap-3">
        <div ref={logRef} className="max-h-48 overflow-y-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap">
          {phase.text === "" ? t("llmWaiting") : phase.text}
        </div>
        <Button size="sm" variant="outline" className="self-end" onClick={() => abortRef.current?.abort()}>
          {t("llmCancel")}
        </Button>
      </div>
    );
  } else if (profiles.length === 0) {
    // 「跑过没有」必须看持久化的 cached，不能看会话内的 stats——
    // stats 只在本次跑完后才有值，刷新页面就回到 null，会把
    // 「解析过、AI 也没找到」错显成「还没跑过」，诱导用户重复花钱再跑一次。
    // 这个区分从数据库的独立列一路传到这里，不能在最后一层丢掉
    const everRan = stats !== null || cached !== null;
    content = (
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm text-muted-foreground">
          {everRan ? t("llmFoundNothing") : t("llmIntro")}
        </p>
        {phase.kind === "error" && <p className="text-xs text-destructive">{phase.message}</p>}
        <Button size="sm" onClick={() => void start()}>
          <Sparkles className="size-3.5" />
          {everRan ? t("llmRerun") : t("llmStart")}
        </Button>
      </div>
    );
  } else {
    content = (
      <div className="flex flex-col gap-3">
        {cached?.stale === true && <p className="text-xs text-muted-foreground">{t("llmStale")}</p>}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {profiles.map((profile) => (
            <RecommendProfileCard
              key={profile.id}
              profile={profile}
              modelLabel={runModel ?? cached?.model ?? undefined}
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

  return (
    <>
      {content}
      <LlmDiffDialog
        repoId={repoId}
        pending={pendingOverwrite}
        previous={profiles}
        onResolved={(newProfiles) => {
          // 覆盖生效：卡片、计数、模型名一并切到新结果——上面 done 分支里
          // stats 被撑住没跟着抢跑，就是为了在这一刻才和 profiles 一起落地
          setProfiles(newProfiles);
          if (pendingOverwrite !== null) {
            setStats({ offered: pendingOverwrite.offered, dropped: pendingOverwrite.dropped });
            setRunModel(pendingOverwrite.model);
          }
        }}
        onOpenChange={(open) => { if (!open) setPendingOverwrite(null); }}
      />
    </>
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
