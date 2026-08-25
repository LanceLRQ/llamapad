"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, Cpu, Database, Gauge, Layers, MemoryStick, Zap } from "lucide-react";
import { useTranslations } from "next-intl";
import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";

import { Card, CardContent } from "@/components/ui/card";
import {
  type ContainerStatsPayload,
  type GpuStatsPayload,
  type LatestSample,
} from "@/server/metrics/latest";
import { METRIC_IDS } from "@/server/metrics/ids";
import type { NvidiaStatus } from "@/server/metrics/nvidiaSmi";
import { type WindowPayload, type WindowPoint } from "@/server/metrics/window";

/**
 * 监控页指标卡网格（M3 Task 5）：每卡 = 当前值大数字 + 单位 + 30m sparkline
 * 迷你面积图。数据两路：
 * - 当前值：/api/v1/container/stats + /api/v1/gpu/stats，5s 轮询
 *   （页面不可见跳过，回到可见立即补拉——与概览图表同款节拍）
 * - sparkline：/api/v1/metrics/window?range=30m 只取对应序列末 60 点，30s 刷新
 *
 * GPU 三态（M5 Task 4）：gpu/stats 的 status 区分 probing（探测中，面板刚
 * 重启的窗口期）/ unavailable（确认不可用）/ available。探测中既不显示
 * GPU 卡也不出提示条（避免首帧误报"不可用"）；只有确认不可用才出页顶
 * 提示条说明需 --gpus 部署（M4 真机联调）。
 * SSR 取舍同 overview-charts：图表仅在有数据时渲染，首帧恒空不触 recharts
 * 服务端执行。
 */

/** sparkline 保留点数（30m @5s ≈ 360 点，取末 60 点 ≈ 最近 5 分钟） */
const SPARK_POINTS = 60;

/** 当前值轮询间隔 */
const STATS_POLL_MS = 5_000;
/** sparkline 刷新间隔（窗口查询含 15min 桶降源，无需跟 5s 节拍） */
const SPARK_POLL_MS = 30_000;

/** 卡片展示值：文本 + 单位（单位随量级换算，见各格式化器） */
interface CardValue {
  value: string;
  unit: string;
}

/** 百分比：≥100 取整，否则一位小数 */
function formatPercent(v: number): CardValue {
  return { value: v >= 100 ? String(Math.round(v)) : v.toFixed(1), unit: "%" };
}

/** MiB 量级展示：<1GiB 用整数 MiB，≥1GiB 一位小数 GiB */
function formatMib(mib: number): CardValue {
  return mib >= 1024
    ? { value: (mib / 1024).toFixed(1), unit: "GiB" }
    : { value: String(Math.round(mib)), unit: "MiB" };
}

/** tokens 紧凑展示：≥1M/≥1k 一位小数缩写，否则整数 */
function formatTokensCompact(v: number): CardValue {
  if (v >= 1_000_000) return { value: `${(v / 1_000_000).toFixed(1)}M`, unit: "tok" };
  if (v >= 1_000) return { value: `${(v / 1_000).toFixed(1)}k`, unit: "tok" };
  return { value: String(Math.round(v)), unit: "tok" };
}

/** 卡片定义：指标 id + 图标 + i18n 键 + sparkline 色 + 值格式化 */
interface CardDef {
  key: string;
  metric: string;
  gpu: boolean;
  icon: typeof Cpu;
  labelKey:
    | "cardCpu"
    | "cardMem"
    | "cardTokensPerSec"
    | "cardKvCache"
    | "cardSlots"
    | "cardGpuMem"
    | "cardGpuUtil";
  colorVar: string;
  format: (v: number) => CardValue;
  /** sparkline 点预处理（mem_bytes → MiB） */
  transform?: (v: number) => number;
}

const CARD_DEFS: CardDef[] = [
  {
    key: "cpu",
    metric: METRIC_IDS.containerCpuPercent,
    gpu: false,
    icon: Cpu,
    labelKey: "cardCpu",
    colorVar: "var(--chart-1)",
    format: formatPercent,
  },
  {
    key: "mem",
    metric: METRIC_IDS.containerMemBytes,
    gpu: false,
    icon: MemoryStick,
    labelKey: "cardMem",
    colorVar: "var(--chart-5)",
    format: (v) => formatMib(v / 1024 / 1024),
    transform: (v) => v / 1024 / 1024,
  },
  {
    key: "tps",
    metric: METRIC_IDS.inferTokensPerSec,
    gpu: false,
    icon: Activity,
    labelKey: "cardTokensPerSec",
    colorVar: "var(--chart-2)",
    format: (v) => ({ value: v.toFixed(1), unit: "tok/s" }),
  },
  {
    key: "kv",
    metric: METRIC_IDS.inferKvCacheTokens,
    gpu: false,
    icon: Database,
    labelKey: "cardKvCache",
    colorVar: "var(--chart-3)",
    format: formatTokensCompact,
  },
  {
    key: "slots",
    metric: METRIC_IDS.inferSlotsRunning,
    gpu: false,
    icon: Layers,
    labelKey: "cardSlots",
    colorVar: "var(--chart-4)",
    format: (v) => ({ value: String(Math.round(v)), unit: "" }),
  },
  {
    key: "gpuMem",
    metric: METRIC_IDS.gpuMemUsedMib,
    gpu: true,
    icon: Zap,
    labelKey: "cardGpuMem",
    colorVar: "var(--chart-1)",
    format: formatMib,
  },
  {
    key: "gpuUtil",
    metric: METRIC_IDS.gpuUtilPercent,
    gpu: true,
    icon: Gauge,
    labelKey: "cardGpuUtil",
    colorVar: "var(--chart-5)",
    format: formatPercent,
  },
];

/** sparkline 行（recharts dataKey v） */
interface SparkRow {
  v: number;
}

/** 迷你面积 sparkline：无轴无 tooltip；序列过短（<2 点）返回占位空 div */
function Sparkline({ points, colorVar, gradientId }: {
  points: WindowPoint[];
  colorVar: string;
  gradientId: string;
}) {
  const data: SparkRow[] = useMemo(
    () => points.slice(-SPARK_POINTS).map((p) => ({ v: p.value })),
    [points],
  );

  if (data.length < 2) {
    return <div aria-hidden className="h-9" />;
  }

  // 手动算域：常值序列（min==max）时 YAxis 自动域会退化，补 15% 边距兜底
  const values = data.map((d) => d.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = max === min ? Math.max(Math.abs(max) * 0.1, 1) : (max - min) * 0.15;

  return (
    <div className="h-9">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 3, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colorVar} stopOpacity={0.3} />
              <stop offset="100%" stopColor={colorVar} stopOpacity={0.03} />
            </linearGradient>
          </defs>
          <YAxis hide domain={[min - pad, max + pad]} />
          <Area
            dataKey="v"
            type="monotone"
            stroke={colorVar}
            strokeWidth={1.5}
            fill={`url(#${gradientId})`}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function MetricCard({ def, sample, spark }: {
  def: CardDef;
  sample: LatestSample | undefined;
  spark: WindowPoint[];
}) {
  const t = useTranslations("pages.monitoring");
  const shown = sample !== undefined ? def.format(sample.value) : null;
  const Icon = def.icon;

  return (
    <Card size="sm">
      <CardContent>
        <div className="flex items-center gap-1.5 text-xs font-semibold">
          <Icon className="size-3.5 text-muted-foreground" />
          {t(def.labelKey)}
        </div>
        <div className="mt-1 flex items-baseline gap-1.5">
          <span className="font-mono text-xl leading-tight font-bold tabular-nums">
            {shown?.value ?? "—"}
          </span>
          {shown !== null && shown.unit !== "" && (
            <span className="text-xs text-muted-foreground">{shown.unit}</span>
          )}
        </div>
        <div className="mt-1.5">
          <Sparkline
            points={
              def.transform !== undefined
                ? spark.map((p) => ({ ts: p.ts, value: def.transform?.(p.value) ?? p.value }))
                : spark
            }
            colorVar={def.colorVar}
            gradientId={`spark-${def.key}`}
          />
        </div>
      </CardContent>
    </Card>
  );
}

export function MonitoringMetricCards({
  /** SSR 直传 nvidia 三态（服务端单例 probe 结果）：首帧即据此决定卡片/提示条呈现 */
  initialGpuStatus,
}: {
  initialGpuStatus: NvidiaStatus;
}) {
  const t = useTranslations("pages.monitoring");
  const [containerStats, setContainerStats] = useState<ContainerStatsPayload | null>(null);
  const [gpuStatus, setGpuStatus] = useState<NvidiaStatus>(initialGpuStatus);
  const [gpuSamples, setGpuSamples] = useState<{ [metric: string]: LatestSample } | null>(
    initialGpuStatus === "available" ? {} : null,
  );
  const [statsFailed, setStatsFailed] = useState(false);
  const [spark, setSpark] = useState<WindowPayload | null>(null);

  const loadStats = useCallback(async (signal?: AbortSignal) => {
    try {
      const [container, gpu] = await Promise.all([
        fetch("/api/v1/container/stats", { signal, cache: "no-store" }),
        fetch("/api/v1/gpu/stats", { signal, cache: "no-store" }),
      ]);
      if (!container.ok || !gpu.ok) throw new Error("stats http error");
      setContainerStats((await container.json()) as ContainerStatsPayload);
      const gpuPayload = (await gpu.json()) as GpuStatsPayload;
      setGpuStatus(gpuPayload.status);
      setGpuSamples(gpuPayload.samples ?? {});
      setStatsFailed(false);
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        return;
      }
      setStatsFailed(true);
    }
  }, []);

  const loadSpark = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/v1/metrics/window?range=30m", { signal, cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSpark((await res.json()) as WindowPayload);
    } catch {
      // sparkline 失败静默：当前值照常轮询，卡片只少一条趋势线
    }
  }, []);

  // 当前值 5s 轮询（visibility 暂停，回到可见立即补拉）
  useEffect(() => {
    const controller = new AbortController();
    const tick = () => {
      if (!document.hidden) void loadStats(controller.signal);
    };
    const timer = setInterval(tick, STATS_POLL_MS);
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
  }, [loadStats]);

  // sparkline 30s 刷新（同款可见性节拍）
  useEffect(() => {
    const controller = new AbortController();
    const tick = () => {
      if (!document.hidden) void loadSpark(controller.signal);
    };
    const timer = setInterval(tick, SPARK_POLL_MS);
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
  }, [loadSpark]);

  // GPU 三态：探测中也不显示 GPU 卡（避免闪现空卡）；只有确认不可用才显示红字提示
  const gpuHidden = gpuStatus !== "available";
  const showGpuHint = gpuStatus === "unavailable";

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <h2 className="text-xs font-semibold tracking-tight text-muted-foreground">
          {t("cardsTitle")}
        </h2>
        {statsFailed && <p className="text-xs text-destructive">{t("loadError")}</p>}
      </div>

      {/* 确认不可用（非探测中）：隐藏 GPU 两卡，页顶提示条说明部署要求 */}
      {showGpuHint && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          {t("gpuHint")}
        </p>
      )}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
        {CARD_DEFS.filter((def) => !def.gpu || !gpuHidden).map((def) => (
          <MetricCard
            key={def.key}
            def={def}
            sample={
              def.gpu
                ? (gpuSamples?.[def.metric] ?? undefined)
                : (containerStats?.samples[def.metric] ?? undefined)
            }
            spark={spark?.series[def.metric] ?? []}
          />
        ))}
      </div>
    </section>
  );
}
