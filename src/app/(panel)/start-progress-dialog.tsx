"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CircleCheck, Lightbulb, Loader2, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/toast-store";
import { apiFetch } from "@/lib/api";
import { advanceLoadProgress, INITIAL_LOAD_PROGRESS, type LoadProgress } from "@/lib/load-progress";
import { diagnoseStartFailure, type AdviceKind } from "@/lib/start-advice";

/**
 * 启动进度浮层（UX P0 Task 8 / U2+U4）：把"点 Start 后按钮转圈到 HTTP 返回"
 * 的黑盒照亮——大模型从磁盘加载 + CUDA 初始化要 10s～几分钟。
 *
 * 数据源（全部复用既有设施，无新端点）：
 * - POST /api/v1/models/:name/start：请求本身阻塞到容器稳定（服务端原子
 *   stop+start，即"切换"也走这里）；返回即成功兜底
 * - EventSource /api/v1/logs/stream：日志行喂 load-progress 解析器出进度，
 *   最近 8 行恒显兜底（解析 best-effort，见 07 计划风险簿①）
 * - GET /api/v1/runtime/status 每 2s 轮询：running.model 命中即成功（比 HTTP
 *   返回更早给出"已就绪"信号；也是 restart 场景的判据）
 *
 * 失败呈现：HTTP 错误体（含服务端嵌入的日志尾）原样展示 + 建议映射
 * （start-advice，Task 9 接入）。拉镜像提示（U7 P0）：15s 无任何日志行时
 * 显示"可能正在拉取镜像"——首次启动 docker pull 无进度事件，至少不装死。
 *
 * 显存预警（U17）：挂载即拉一次 GET /api/v1/models/:name/preflight，
 * verdict==="warn" 时在对话框顶部出琥珀提示（当前空闲显存 vs 该模型历史
 * 净增量峰值）。只提示不拦截——显存估算本就不精确（量化/ctx/KV 类型都会
 * 变），硬拦会挡住合法操作，且 llama.cpp 装不下会自己报错，失败态已接住；
 * ok/unknown 不出任何提示，请求失败静默跳过，绝不能因为这条辅助信息挂了
 * 反过来挡住启动主流程。两个入口共用本组件，挂这一处即覆盖全部启动路径。
 */

const TAIL_LINES = 8;
const STATUS_POLL_MS = 2_000;
const PULL_HINT_MS = 15_000;

type Phase = "starting" | "success" | "failed";

/** GET /api/v1/models/:name/preflight 响应（milestones/11 §2.5） */
interface PreflightResponse {
  verdict: "ok" | "warn" | "unknown";
  freeMib: number | null;
  totalMib: number | null;
  peakNetMib: number | null;
  runCount: number;
}

/** MiB → GiB 一位小数字符串（预警提示文案用，显存量纲固定 GiB 不必按量级切换单位） */
function toGib(mib: number): string {
  return `${(mib / 1024).toFixed(1)} GiB`;
}

/**
 * 挂载即会话：调用方以 `{open && <StartProgressDialog …/>}` 条件挂载，
 * 每次打开都是全新实例（初始态由 useState 初始化承载，无重置 effect）。
 */
export function StartProgressDialog({
  onOpenChange,
  modelName,
  displayName,
  /** 动作名（start 走日志流判就绪；restart 同） */
  action = "start",
  /** 切换语义（U4）：当前运行的其他模型名——服务端启动前会原子停掉它 */
  switchingFrom = null,
}: {
  onOpenChange: (open: boolean) => void;
  modelName: string;
  displayName: string;
  action?: "start" | "restart";
  switchingFrom?: string | null;
}) {
  const t = useTranslations("pages.startProgress");
  const router = useRouter();

  const [phase, setPhase] = useState<Phase>("starting");
  const [progress, setProgress] = useState<LoadProgress>(INITIAL_LOAD_PROGRESS);
  const [tail, setTail] = useState<string[]>([]);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [sawLogLine, setSawLogLine] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  /** 容器已起（POST /start 返回 2xx），但模型是否加载完成交给下面的状态轮询裁定——
   * 真机实测 27B 模型容器起来后还要几十秒才 listening，POST 返回不再等同"已就绪" */
  const [containerUp, setContainerUp] = useState(false);

  const doneRef = useRef(false);

  /** 显存预警：warn 时填充展示文案，其余情况（ok/unknown/请求失败）保持 null 不出提示 */
  const [preflightWarn, setPreflightWarn] = useState<{ free: string; peak: string; count: number } | null>(
    null,
  );

  // ---- 显存预警（U17）：与主流程解耦的独立一次性拉取，失败静默、绝不挡启动 ----
  useEffect(() => {
    let cancelled = false;
    apiFetch(`/api/v1/models/${encodeURIComponent(modelName)}/preflight`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as PreflightResponse;
        if (cancelled || data.verdict !== "warn" || data.freeMib === null || data.peakNetMib === null) {
          return;
        }
        setPreflightWarn({ free: toGib(data.freeMib), peak: toGib(data.peakNetMib), count: data.runCount });
      })
      .catch(() => {
        // 预警拉取失败静默跳过：这只是辅助提示，不能反过来挡住启动
      });
    return () => {
      cancelled = true;
    };
  }, [modelName]);

  const succeed = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    setPhase("success");
    toast.success(t("successToast", { name: displayName }));
    router.refresh();
    // 停留 800ms 让用户看到绿勾，再自动收起
    setTimeout(() => onOpenChange(false), 800);
  }, [displayName, onOpenChange, router, t]);

  // ---- 主流程：挂载即发起点（start 请求 + 日志流 + 状态轮询）----
  useEffect(() => {
    const startedAt = Date.now();
    const elapsedTimer = setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );

    // 1) 启动请求：resolve 即成功兜底（容器已稳定）；错误体进失败态
    apiFetch(`/api/v1/models/${encodeURIComponent(modelName)}/${action}`, {
      method: "POST",
    })
      .then(async (res) => {
        if (res.ok) {
          // 容器已稳定，但模型未必已监听端口——是否成功交给下面的状态轮询裁定
          setContainerUp(true);
          return;
        }
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `${res.status}`);
      })
      .catch((error: unknown) => {
        if (doneRef.current) return;
        doneRef.current = true;
        setPhase("failed");
        setErrorText(error instanceof Error ? error.message : String(error));
      });

    // 2) 日志流：喂解析器 + 维护尾行窗口
    const source = new EventSource("/api/v1/logs/stream");
    source.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as { type?: string; line?: string };
        if (msg.type === "log" && typeof msg.line === "string") {
          setSawLogLine(true);
          setProgress((prev) => advanceLoadProgress(prev, msg.line!));
          setTail((prev) => [...prev.slice(-(TAIL_LINES - 1)), msg.line!]);
        }
      } catch {
        // 非 JSON 帧忽略（与 terminal.tsx 同防御）
      }
    };

    // 3) 运行状态轮询：running.model 命中且 ready（llama-server 已监听）→ 判成功。
    // 只等 model 命中会提前收绿勾——容器起了不代表模型加载完，真机 27B 实测中间
    // 还有几十秒空窗（见 readiness.ts 头注释）
    const statusTimer = setInterval(async () => {
      try {
        const res = await apiFetch("/api/v1/runtime/status", { cache: "no-store" });
        if (!res.ok) return;
        const status = (await res.json()) as { running: { model: string; ready: boolean } | null };
        if (status.running?.model === modelName && status.running?.ready === true) succeed();
      } catch {
        // 轮询失败不致命（断线横幅会接力）
      }
    }, STATUS_POLL_MS);

    return () => {
      clearInterval(elapsedTimer);
      clearInterval(statusTimer);
      source.close();
    };
  }, [modelName, action, succeed]);

  const percent = phase === "success" ? 100 : progress.percent;
  const showPullHint = phase === "starting" && !sawLogLine && elapsed >= PULL_HINT_MS / 1000;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        // 前 5s 挡误触关闭（遮罩/ESC）；之后自由关闭，"后台继续"按钮同效
        if (next === false && phase === "starting" && elapsed < 5) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {phase === "success"
              ? t("titleSuccess", { name: displayName })
              : phase === "failed"
                ? t("titleFailed", { name: displayName })
                : switchingFrom
                  ? t("titleSwitching", { name: displayName })
                  : t("titleStarting", { name: displayName })}
          </DialogTitle>
          <DialogDescription>
            {switchingFrom && phase === "starting"
              ? t("switchingHint", { from: switchingFrom })
              : t("description")}
          </DialogDescription>
        </DialogHeader>

        {preflightWarn && (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            {t("preflightWarn", preflightWarn)}
          </p>
        )}

        {phase === "starting" && (
          // min-w-0 不能省：DialogContent 是 grid，grid 子项默认 min-width:auto，
          // 下面日志块里 truncate 的 white-space:nowrap 会把轨道撑到 min-content
          // 宽度，整块直接顶破弹层（失败态那块因为 break-words 会换行，没这个问题）
          <div className="flex min-w-0 flex-col gap-3">
            {/* 进度条 + 阶段标签 + 计时 */}
            <div className="flex items-center gap-3">
              <Loader2 className="size-4 animate-spin text-primary" />
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-500"
                  style={{ width: `${Math.max(3, percent)}%` }}
                />
              </div>
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {percent}%
              </span>
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {progress.stage === "ready" ? t("stageReady") : t("stageLoading")}
              </span>
              <span className="font-mono tabular-nums">{t("elapsed", { seconds: elapsed })}</span>
            </div>

            {/* 容器已确认起来（POST 已 resolve），但还没等到就绪轮询翻绿——
                与上面按日志猜的 stageLoading 不同，这是服务端确证的状态 */}
            {containerUp && <p className="text-xs text-muted-foreground">{t("loadingModel")}</p>}

            {showPullHint && (
              <p className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                {t("pullHint")}
              </p>
            )}

            {/* 最近日志尾行：解析 best-effort 的诚实兜底 */}
            <div className="min-w-0 rounded-md bg-[#101013] px-3 py-2 font-mono text-[11px] leading-relaxed text-[#fafafa]">
              {tail.length === 0 ? (
                <p className="text-[#a1a1aa]">{t("waitingLogs")}</p>
              ) : (
                tail.map((line, index) => (
                  <p key={index} className="truncate" title={line}>
                    {line}
                  </p>
                ))
              )}
            </div>

            {elapsed >= 5 && (
              <Button variant="ghost" size="sm" className="self-end" onClick={() => onOpenChange(false)}>
                {t("runInBackground")}
              </Button>
            )}
          </div>
        )}

        {phase === "success" && (
          <div className="flex items-center gap-2.5 text-sm text-accent-green">
            <CircleCheck className="size-4" />
            {t("successBody")}
          </div>
        )}

        {phase === "failed" && (
          <div className="flex flex-col gap-3">
            <div className="flex items-start gap-2.5 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-xs leading-relaxed text-destructive">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0 break-words whitespace-pre-wrap">{errorText}</span>
            </div>
            {/* 失败 → 建议（UX P0 Task 9）：把错误翻译成下一步动作 */}
            <Advice kind={diagnoseStartFailure([errorText ?? "", ...tail].join("\n"))} />
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                {t("close")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 建议文案：错误体 + 日志尾行联合诊断（诊断不中给通用建议，不误导） */
function Advice({ kind }: { kind: AdviceKind }) {
  const t = useTranslations("pages.startProgress");
  return (
    <div className="flex items-start gap-2.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
      <Lightbulb className="mt-0.5 size-4 shrink-0" />
      <span>{t(`advice.${kind}`)}</span>
    </div>
  );
}
