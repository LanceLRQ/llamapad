"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Sparkles, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";

import type { ServerConfig } from "@/core/schemas";
import { LlmDiffDialog } from "@/components/models/llm-diff-dialog";
import { RecommendProfileCard } from "@/components/models/recommend-profile-card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LineSplitter } from "@/core/line-splitter";
import { apiFetch } from "@/lib/api";
import { buildLlmTargets, llmTargetId, type LlmTarget } from "@/lib/llm-targets";
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
  noReadme: "llmError.noReadme",
};

/** GET /api/v1/settings/llm 响应形状（客户端不引 server 模块，只取本组件要用的字段） */
interface LlmSettingsInfo {
  externalReady: boolean;
  model: string | null;
  missing: ("baseUrl" | "apiKey" | "model")[];
  runningModels: string[];
}

export function LlmExtractPanel({
  repoId,
  effective,
  repoBaseName,
  cached,
  onApply,
  onSaveAsPreset,
  onResultLanded,
}: {
  repoId: number;
  effective: ServerConfig;
  repoBaseName: string;
  cached: { profiles: unknown[]; model: string | null; parsedAt: number | null; stale: boolean } | null;
  onApply: (profileId: string, server: Partial<ServerConfig>) => void;
  onSaveAsPreset: (server: Partial<ServerConfig>, name: string) => void;
  /** 结果真正落库之后调用（首次解析落库 / 重跑覆盖成功），不是每次流结束都调用——
   *  重跑但用户还没在弹层里选「覆盖」时不算落库。父组件借此机会重取 README，
   *  让 `cached.stale` 与 tab 计数跟上这次新落库的结果，而不是永远落后一拍 */
  onResultLanded?: () => void;
}) {
  const t = useTranslations("pages.repos");
  // 候选集所需的原始信息，只读一次配置，不发任何 LLM 请求
  const [settingsInfo, setSettingsInfo] = useState<LlmSettingsInfo | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [profiles, setProfiles] = useState<RecommendedProfile[]>(
    () => (cached?.profiles ?? []) as RecommendedProfile[],
  );
  const [stats, setStats] = useState<{ offered: number; dropped: number } | null>(null);
  /** 本次跑出来的模型名。cached.model 只覆盖「刷新页面后」那条路径，
   *  首次落库这次跑的模型名不记下来就显示不出来 */
  const [runModel, setRunModel] = useState<string | null>(null);
  // 重跑覆盖对比弹层（任务 16）：`done` 帧在 hadPrevious 分支写入这里，
  // LlmDiffDialog 读它决定是否弹出。新计数（offered/dropped）不缓存在这里——
  // 由 save 路由重跑回证后随响应返回，LlmDiffDialog 直接采纳那份响应，
  // 见下面 onResolved 的注释
  const [pendingOverwrite, setPendingOverwrite] = useState<{
    raw: string; engine: string; model: string; profiles: RecommendedProfile[];
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  // 本次使用哪个引擎：不读也不写任何持久化（没有 localStorage、没有请求落库），
  // 只在组件 state 里活，切换只影响本次解析
  const [targetId, setTargetId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await apiFetch("/api/v1/settings/llm").catch(() => null);
      if (!alive || res === null || !res.ok) return;
      const s = (await res.json()) as LlmSettingsInfo;
      setSettingsInfo(s);
    })();
    return () => { alive = false; };
  }, []);

  // 候选 = 已配齐的外部 API（至多一项）+ 每个正在运行的本地模型（0..N 项），
  // 判定下沉 lib/llm-targets.ts；顺序即默认策略，见该文件注释
  const targets = useMemo<LlmTarget[]>(
    () =>
      settingsInfo === null
        ? []
        : buildLlmTargets({
            externalReady: settingsInfo.externalReady,
            externalModel: settingsInfo.model,
            runningModels: settingsInfo.runningModels,
          }),
    [settingsInfo],
  );

  // 候选到手后若用户还没选过，派生出默认选中项（外部优先，见 buildLlmTargets
  // 注释）——渲染期间派生而不是在 effect 里 setState，用户一旦手动选过，
  // targetId 非 null 就一直沿用那个选择，不会被这里的默认值覆盖
  const effectiveTargetId = targetId ?? (targets.length > 0 ? llmTargetId(targets[0]) : null);

  async function start(): Promise<void> {
    // 防御性早退：targets.length === 0 时面板不渲染「开始解析」按钮，
    // 正常不会走到这里；留着这道检查只是不让 null 直接序列化进请求体
    if (effectiveTargetId === null) return;

    const controller = new AbortController();
    abortRef.current = controller;
    // 重跑前的旧计数：hadPrevious 场景要用它把 stats 撑到用户做出选择为止——
    // 卡片内容（profiles）在那之前本就不变，计数不能抢跑，见下方 done 分支
    const priorStats = stats;
    setPhase({ kind: "streaming", text: "" });
    setStats(null);
    // 流正常结束（既没有 error 帧、也没有中途 throw）却一个终帧都没收到——
    // 容器/dev server 在流中途重启走的是正常 TCP FIN，不是异常，上面的 try/catch
    // 抓不住这种情况。这批修掉的四个 Critical 全是「失败没被识别成失败」，
    // 这里是同族的又一个变体：失败被识别成了「还在跑」，phase 卡在 streaming、
    // abortRef 又已在 finally 里置空，「取消」按钮变成空操作，只能刷新整页
    let sawTerminalFrame = false;

    try {
      const res = await apiFetch(`/api/v1/repos/${repoId}/readme/llm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId: effectiveTargetId }),
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
          sawTerminalFrame = true;
          // 这次重跑没成功，界面回到重跑前的样子：卡片本来就没动过，
          // 计数也要跟着回去，否则旧卡片还在、它对应的筛选说明却没了
          setStats(priorStats);
          const key = ERROR_KEY[String(frame.kind)] ?? ERROR_KEY.network;
          setPhase({ kind: "error", message: t(key) });
        } else if (frame.type === "done") {
          sawTerminalFrame = true;
          const result = frame.result as { profiles: RecommendedProfile[]; offered: number; dropped: number };
          if (frame.hadPrevious === true) {
            // 卡片（profiles）在用户选定前不变，计数不能领先于它——撑回重跑前的
            // 旧计数，而不是抢先显示新一次运行的 offered/dropped（时序缺口，见
            // 任务 14/15 报告的遗留疑虑，任务 16 在此闭合）。新计数不缓存在这里，
            // 由 save 路由重跑回证之后随响应返回，见 LlmDiffDialog 的 onResolved
            setStats(priorStats);
            setPendingOverwrite({
              raw: String(frame.raw),
              engine: String(frame.engine),
              model: String(frame.model),
              profiles: result.profiles,
            });
          } else {
            setStats({ offered: result.offered, dropped: result.dropped });
            setProfiles(result.profiles);
            setRunModel(String(frame.model));
            // 首次落库这次跑的结果：通知父组件重取 README，让 cached.stale 与
            // tab 计数跟上——不在 hadPrevious 分支调用，那条路径要等用户在
            // 弹层里选「覆盖」才算真正落库，见下面 LlmDiffDialog 的 onResolved
            onResultLanded?.();
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

      if (!sawTerminalFrame) {
        setStats(priorStats);
        setPhase({ kind: "error", message: t("llmError.badResponse") });
      }
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

  // settingsInfo === null 是「还不知道」，不是「确定没有」——两者不能共用
  // 一个分支。挂载后请求没回来之前 targets 也是空数组（见上面 useMemo），
  // 但那是「还没查完」，不能被当成 noTargets 的「查完了、真的没有」来渲染，
  // 否则每次进页面都会先闪一下「没有可用的解析引擎」
  const loadingSettings = settingsInfo === null;
  // 候选为空：没有任何一条路径能发起解析——外部没配齐、也没有本地模型在跑。
  // 两条路径并列给出，用户按哪条更顺手走哪条，不猜他想用哪个
  const noTargets = targets.length === 0;
  const selectedTarget = targets.find((tg) => llmTargetId(tg) === effectiveTargetId) ?? null;
  const selectedTargetLabel =
    selectedTarget === null
      ? ""
      : selectedTarget.kind === "external"
        ? t("llmTargetExternal", { model: selectedTarget.model })
        : t("llmTargetLocal", { model: selectedTarget.model });

  // 渲染收进一个变量，唯一的 return 里连同弹层一起吐出去——弹层要挂在
  // 每一个分支之外，不能让「无候选」这类早返回分支把它带走
  let content: ReactNode;

  if (!loadingSettings && noTargets) {
    content = (
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm font-medium">{t("llmNoTargetTitle")}</p>
        <Notice
          text={t("llmIncomplete", { fields: (settingsInfo?.missing ?? []).map((m) => t(`llmField.${m}`)).join("、") })}
          action={{ href: "/settings?tab=runtime", label: t("llmGoSettings") }}
        />
        <Notice text={t("llmNoRunningModel")} action={{ href: "/models", label: t("llmGoModels") }} />
      </div>
    );
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
        {stats !== null && stats.dropped > 0 && (
          <p className="text-xs text-muted-foreground">
            {t("llmDropped", { offered: stats.offered, dropped: stats.dropped })}
          </p>
        )}
        {phase.kind === "error" && <p className="text-xs text-destructive">{phase.message}</p>}
        <Button
          size="sm"
          disabled={loadingSettings || effectiveTargetId === null}
          onClick={() => void start()}
        >
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
        <Button
          size="sm"
          variant="outline"
          className="self-end"
          disabled={loadingSettings || effectiveTargetId === null}
          onClick={() => void start()}
        >
          {t("llmRerun")}
        </Button>
      </div>
    );
  }

  return (
    <>
      {/* 「本次使用」选择器：放在面板顶部，只对本次解析生效，不修改设置。
          加载中或候选为空都不渲染——加载中还没有候选可选，noTargets 分支
          已经在 content 里给出引导。显式判 loadingSettings 而不是只靠
          noTargets 巧合成立（加载期间 targets 恰好也是空数组），两个含义
          不同，不该共用同一个判断 */}
      {!loadingSettings && !noTargets && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Label className="text-xs text-muted-foreground">{t("llmTargetLabel")}</Label>
          <Select
            value={effectiveTargetId}
            onValueChange={(v) => {
              if (v !== null) setTargetId(v);
            }}
          >
            <SelectTrigger size="sm" className="w-56" disabled={phase.kind === "streaming"}>
              <SelectValue>{selectedTargetLabel}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {targets.map((target) => {
                const id = llmTargetId(target);
                return (
                  <SelectItem key={id} value={id}>
                    {target.kind === "external"
                      ? t("llmTargetExternal", { model: target.model })
                      : t("llmTargetLocal", { model: target.model })}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">{t("llmTargetHint")}</span>
        </div>
      )}
      {content}
      <LlmDiffDialog
        repoId={repoId}
        pending={pendingOverwrite}
        previous={profiles}
        onResolved={(newProfiles, newStats, newModel) => {
          // 覆盖生效：卡片、计数、模型名一并切到新结果——三样都取自服务端
          // 重跑回证之后的响应，不是用户在弹层里看到的那份客户端旧数据
          // （README 若在中途变了，服务端可能落库更少甚至 0 条）。
          // 无条件采纳、不再判 pendingOverwrite !== null：ESC/点遮罩关闭弹层
          // 会让 pendingOverwrite 提前置 null，但这个回调仍会在请求返回后执行
          // （pending 是闭包捕获的），此时不该因为弹层已关就丢掉三者中的两个
          setProfiles(newProfiles);
          setStats(newStats);
          setRunModel(newModel);
          onResultLanded?.();
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
