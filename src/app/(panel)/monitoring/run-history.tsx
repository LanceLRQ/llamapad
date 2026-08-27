"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { RunRecord } from "@/server/runs";
import { apiFetch } from "@/lib/api";
import { formatDuration, formatPeakNetMib } from "@/lib/run-format";

/**
 * 运行历史区块（U17 T4，milestones/11 §2.6）：把「攒下来的运行数据」摆到监
 * 控页——每次模型启停记一行，列出模型 / 开始时间 / 时长 / 平均 tok/s / 峰值
 * 显存，挂在指标卡网格与终端日志之间。
 *
 * 峰值显存展示净增量（peak_gpu_mem_mib - baseline_gpu_mem_mib）：
 * `gpu.mem_used_mib` 是整卡全局占用，本机常有 comfyui / qwen3-asr 等旁路
 * 任务同时跑，直接展示整卡峰值会让人误以为"这个模型吃了这么多显存"。减掉
 * 启动前的 baseline 才是这次运行自己的净开销，与启动对话框 preflight 提示
 * （start-progress-dialog.tsx）的口径完全一致。换算与边界情形（负增量视为
 * 不可靠数据）由 `@/lib/run-format` 承担并配单测，见其文件头注释。
 *
 * 数据源：GET /api/v1/runs?limit=20，30s 轮询——运行记录的变化频率是"模型
 * 切换"级别，不需要 metric-cards 5s 那么紧，沿用同款可见性节拍（页面不可见
 * 跳过、回到可见立即补拉）。历史为空（还没运行过模型 / 首帧未拉到）整块不
 * 渲染，不留"暂无数据"占位噪音。
 */

const POLL_MS = 30_000;

interface RunsResponse {
  runs: RunRecord[];
}

export function RunHistory() {
  const t = useTranslations("pages.monitoring");
  const locale = useLocale();
  // null = 尚未拉到首帧数据，[] = 拉到了但确实没有历史——两者都不渲染区块
  const [runs, setRuns] = useState<RunRecord[] | null>(null);

  const startedFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
    [locale],
  );

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await apiFetch("/api/v1/runs?limit=20", { signal, cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as RunsResponse;
      setRuns(data.runs);
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        return;
      }
      // 历史区块非核心监控数据，失败静默：不占页顶提示条位置
    }
  }, []);

  // 30s 轮询（visibility 暂停，回到可见立即补拉——与 metric-cards 同款节拍）
  useEffect(() => {
    const controller = new AbortController();
    const tick = () => {
      if (!document.hidden) void load(controller.signal);
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
  }, [load]);

  if (runs === null || runs.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xs font-semibold tracking-tight text-muted-foreground">
        {t("runHistoryTitle")}
      </h2>
      <Card className="gap-0 py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("runHistoryModel")}</TableHead>
              <TableHead className="w-[130px]">{t("runHistoryStarted")}</TableHead>
              <TableHead className="w-[90px]">{t("runHistoryDuration")}</TableHead>
              <TableHead className="w-[110px]">{t("runHistoryTps")}</TableHead>
              <TableHead className="w-[110px]">{t("runHistoryPeakMem")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => {
              const peakNet = formatPeakNetMib(run.peak_gpu_mem_mib, run.baseline_gpu_mem_mib);
              return (
                <TableRow key={run.id}>
                  <TableCell className="font-mono text-[13px] font-semibold">{run.model}</TableCell>
                  <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                    {startedFmt.format(new Date(run.started_at))}
                  </TableCell>
                  <TableCell className="font-mono text-[13px] tabular-nums">
                    {run.ended_at === null
                      ? t("runHistoryRunning")
                      : formatDuration(run.started_at, run.ended_at)}
                  </TableCell>
                  <TableCell className="font-mono text-[13px] tabular-nums">
                    {run.avg_tokens_per_sec === null ? "—" : run.avg_tokens_per_sec.toFixed(1)}
                  </TableCell>
                  <TableCell className="font-mono text-[13px] tabular-nums">{peakNet ?? "—"}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>
    </section>
  );
}
