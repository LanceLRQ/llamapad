"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, Cpu, Maximize2, Server, Zap } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RefreshIntervalSelect } from "@/components/refresh-interval-select";
import {
  LegendItem,
  SeriesChart,
  type SeriesLine,
  type TooltipLine,
  type YAxisConfig,
} from "@/components/series-chart";
import { formatSize } from "@/lib/format";
import {
  buildChartRows,
  downsample,
  formatBytesAxis,
  formatMibAxis,
  formatPercent,
  latestValue,
  mergeSeries,
  toleranceFor,
  type ChartRow,
  type ChartRowsSpec,
  type TwoLineRow,
} from "@/lib/chart-format";
import { METRIC_IDS } from "@/server/metrics/ids";
import { type GpuStatsPayload } from "@/server/metrics/latest";
import type { NvidiaStatus } from "@/server/metrics/nvidiaSmi";
import { RANGE_KEYS, type RangeKey, type WindowPayload } from "@/server/metrics/window";
import { apiFetch } from "@/lib/api";
import { useRefreshInterval } from "@/lib/use-refresh-interval";
import { ChartDialog } from "./chart-dialog";

/**
 * 概览页监控图表（M3 Task 4；拆图卡重构改一卡一轴）：时间范围 Tabs + 响应式
 * 卡片栅格，每卡一根 Y 轴、一个量纲，不再用双 Y 轴把两种单位的序列叠进同一
 * 绘图区（读者分不清哪条线对应哪根轴）。唯一保留两条线共轴的是宿主机网络
 * 收发卡——rx/tx 单位相同（字节/秒），不属于"不同数据叠一起"。
 *
 * SSR 取舍：不用 next/dynamic——图表仅在 data 非空时渲染，而 data 只可能
 * 来自客户端 fetch（useEffect），SSR 首帧 data 恒为 null，recharts 不会
 * 在服务端执行（无 window 告警）；省掉一层动态加载边界，首屏更简单。
 *
 * 空态语义（与 window API 的"空数组=未采集"约定对应，按分组处理，同组卡
 * 一起隐藏/一起空——避免"一张卡有数据、同组另一张空着还占位"的割裂感）：
 * - GPU 组（显存 / 利用率两卡）：按 gpuStatus 判隐藏（初值取 SSR 传入的
 *   initialGpuStatus，随窗口轮询顺带刷新 /api/v1/gpu/stats 更新，与
 *   monitoring/metric-cards 同构，M5 Task 4）。不能只看序列空否——SQLite
 *   聚合桶留有历史点，GPU 降级后序列仍非空，若只按空数组判会显示一条停滞
 *   曲线不隐藏；也不能只用 SSR 静态快照——面板重启后首帧若探测未完成会把
 *   probing 误判为不可用，且无刷新入口时永不自愈。两卡同源于一次 nvidia-smi
 *   探测，拆开后仍共用同一个隐藏判据，不允许一卡有数据、另一卡因探测抖动
 *   单独隐藏
 * - 推理组（生成速率 / 活跃槽位两卡）：两序列同源于 /health+/slots 一次
 *   探测，同 GPU 组的理由，共用一个隐藏判据（两序列全空 → 两卡都不渲染）
 * - 宿主机组（CPU/内存/负载/磁盘剩余/网络收发五卡）与容器组（CPU/内存两卡）：
 *   每卡按自己的序列独立判空态文案，不共享判据——这五/两个指标虽同源于
 *   同一次采集 tick，但语义上互相独立（缺 CPU 不代表磁盘统计也失败，
 *   statfs 与 os.cpus() 是两条完全不同的失败路径），拆开前"容器卡恒渲染，
 *   无样本时显示空态文案"就是这个策略，拆开后原样沿用到每一张卡
 *
 * 自动刷新按档位：30m/2h 用页顶 RefreshIntervalSelect 选中的间隔（默认 5s，
 * 记在 localStorage，见 lib/refresh-interval.ts）、24h/7d 恒 60s——这两档
 * 背后是分钟级/15 分钟级 SQLite 聚合桶，秒级轮询没有意义，不受选择器影响。
 * 页面不可见时跳过（回到可见立即补拉一次）。数据点 >500 时按步进采样抽稀
 * 防 recharts 卡顿（downsample，见 lib/chart-format.ts）。
 */

function isRangeKey(value: unknown): value is RangeKey {
  return typeof value === "string" && (RANGE_KEYS as readonly string[]).includes(value);
}

// 宿主机网络收发 / 负载卡的格式化：不依赖 props/state 的纯换算，提到模块
// 作用域，字节/秒的换算与拼接只在这一处，tooltip 与图例、轴刻度共用，
// 避免三处各写一遍 "/s" 拼接
function formatBytesPerSec(v: number): string {
  return `${formatSize(v)}/s`;
}
function formatBytesAxisPerSec(v: number): string {
  return `${formatBytesAxis(v)}/s`;
}
function formatLoad(v: number): string {
  return v.toFixed(2);
}

// 各卡的取行描述符：不依赖 props/state，提到模块作用域一次性建好——既喂给
// 本组件的 buildChartRows，也原样透传给放大弹层，弹层按自己选的 range 重新
// buildChartRows 时用的是同一份描述符，取行口径不会因为多写一份而漂移
const GPU_MEM_SPEC: ChartRowsSpec = { kind: "single", metric: METRIC_IDS.gpuMemUsedMib };
const GPU_UTIL_SPEC: ChartRowsSpec = { kind: "single", metric: METRIC_IDS.gpuUtilPercent };
const CONTAINER_CPU_SPEC: ChartRowsSpec = { kind: "single", metric: METRIC_IDS.containerCpuPercent };
const CONTAINER_MEM_SPEC: ChartRowsSpec = { kind: "single", metric: METRIC_IDS.containerMemBytes };
const HOST_CPU_SPEC: ChartRowsSpec = { kind: "single", metric: METRIC_IDS.hostCpuPercent };
const HOST_MEM_SPEC: ChartRowsSpec = { kind: "single", metric: METRIC_IDS.hostMemUsedBytes };
const HOST_LOAD_SPEC: ChartRowsSpec = { kind: "single", metric: METRIC_IDS.hostLoad1 };
const HOST_DISK_SPEC: ChartRowsSpec = { kind: "single", metric: METRIC_IDS.hostDiskFreeBytes };
const HOST_NET_SPEC: ChartRowsSpec = {
  kind: "pair",
  metricA: METRIC_IDS.hostNetRxBytesPerSec,
  metricB: METRIC_IDS.hostNetTxBytesPerSec,
};
const INFER_TOKENS_SPEC: ChartRowsSpec = { kind: "single", metric: METRIC_IDS.inferTokensPerSec };
const INFER_SLOTS_SPEC: ChartRowsSpec = { kind: "single", metric: METRIC_IDS.inferSlotsRunning };

function ChartCardHeader({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Zap;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="flex items-center gap-1.5 text-xs font-semibold">
        <Icon className="size-3.5 text-muted-foreground" />
        {title}
      </span>
      <div className="flex-1" />
      {children}
    </div>
  );
}

// ---------- 单轴图卡（一卡一 Y 轴；网络卡的 rx/tx 共轴算例外，仍只有一个 <YAxis>）----------

interface SeriesChartCardProps {
  icon: typeof Zap;
  title: string;
  legend: { colorClass: string; label: string; value: string | null }[];
  rows: ChartRow[];
  /** 本卡的取行方式，原样透传给放大弹层——弹层按自己选的 range 重新
   *  buildChartRows，与卡片走同一条取行路径 */
  rowsSpec: ChartRowsSpec;
  /** 页面当前选中的时间档位，作为弹层打开时的初始档位（弹层内切换不回写页面） */
  range: RangeKey;
  lines: SeriesLine[];
  tooltipLines: TooltipLine[];
  timeFmt: Intl.DateTimeFormat;
  axisTimeFmt: Intl.DateTimeFormat;
  yAxis: YAxisConfig;
  /** 按 gpuStatus / 两序列皆空判定的整组隐藏（GPU、推理两组用）；true 时整卡不渲染 */
  hidden?: boolean;
  /** 按本卡自身序列判定的空态（宿主机、容器各卡独立判断）；true 时卡片仍渲染，内部换成空态文案 */
  isEmpty?: boolean;
  emptyLabel?: string;
}

function SeriesChartCard({
  icon,
  title,
  legend,
  rows,
  rowsSpec,
  range,
  lines,
  tooltipLines,
  timeFmt,
  axisTimeFmt,
  yAxis,
  hidden,
  isEmpty,
  emptyLabel,
}: SeriesChartCardProps) {
  const t = useTranslations("pages.overview");
  const [dialogOpen, setDialogOpen] = useState(false);
  // 首次点击才挂载弹层（11 张卡没人点就没有 11 份弹层状态），挂载后不再卸载，
  // 只靠 open 切换——Dialog 的关闭动画需要 DOM 在 data-closed 期间还留着，
  // 卸载会让动画来不及播完
  const [dialogMounted, setDialogMounted] = useState(false);
  // 弹层自己的 range，只在"点击放大"这一刻从页面当前 range 播种——弹层常驻
  // 挂载意味着这份 state 不会随页面切档自动更新，必须在每次打开时显式重播，
  // 否则重开同一张卡会停在上次在弹层里选的档位而不是页面当前档位
  const [dialogRange, setDialogRange] = useState<RangeKey>(range);
  if (hidden) return null;
  return (
    <Card>
      <CardContent>
        <ChartCardHeader icon={icon} title={title}>
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[11px] text-muted-foreground">
            {legend.map((item) => (
              <LegendItem key={item.label} {...item} />
            ))}
          </div>
          {/* 空态没有数据可放大，不渲染入口；hidden 卡整卡已不渲染 */}
          {!isEmpty && (
            <Button
              variant="ghost"
              size="icon-sm"
              title={t("chartsExpand")}
              onClick={() => {
                setDialogRange(range);
                setDialogMounted(true);
                setDialogOpen(true);
              }}
            >
              <Maximize2 />
              <span className="sr-only">{t("chartsExpand")}</span>
            </Button>
          )}
        </ChartCardHeader>
        {isEmpty ? (
          <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">
            {emptyLabel}
          </div>
        ) : (
          <div className="mt-2 h-40">
            <SeriesChart
              rows={rows}
              lines={lines}
              tooltipLines={tooltipLines}
              timeFmt={timeFmt}
              axisTimeFmt={axisTimeFmt}
              yAxis={yAxis}
            />
          </div>
        )}
      </CardContent>
      {dialogMounted && (
        <ChartDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          title={title}
          icon={icon}
          range={dialogRange}
          onRangeChange={setDialogRange}
          rowsSpec={rowsSpec}
          lines={lines}
          tooltipLines={tooltipLines}
          yAxis={yAxis}
        />
      )}
    </Card>
  );
}

// ---------- 主组件 ----------

export function OverviewCharts({ initialGpuStatus }: { initialGpuStatus: NvidiaStatus }) {
  const t = useTranslations("pages.overview");
  const locale = useLocale();
  const { intervalMs } = useRefreshInterval();
  const [range, setRange] = useState<RangeKey>("30m");
  /** 已加载数据带 range 标记：切窗后旧窗数据自动失效（≠当前 range 即视为空） */
  const [loaded, setLoaded] = useState<{ range: RangeKey; payload: WindowPayload } | null>(null);
  const [failed, setFailed] = useState(false);
  /** GPU 三态：初值取 SSR 快照，之后随窗口轮询顺带刷新（同 metric-cards 判据） */
  const [gpuStatus, setGpuStatus] = useState<NvidiaStatus>(initialGpuStatus);
  const data = loaded !== null && loaded.range === range ? loaded.payload : null;

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await apiFetch(`/api/v1/metrics/window?range=${range}`, {
          signal,
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = (await res.json()) as WindowPayload;
        if (signal?.aborted) return; // 切窗竞态：迟到响应丢弃
        setLoaded({ range, payload });
        setFailed(false);
      } catch (error) {
        if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
          return;
        }
        setFailed(true);
      }

      // GPU 三态顺带刷新：独立 try/catch，失败静默保留旧值（不拖累上面 failed
      // 提示、不让 GPU 卡因一次轮询失败而闪烁），与 metric-cards 的容错策略一致
      try {
        const gpuRes = await apiFetch("/api/v1/gpu/stats", { signal, cache: "no-store" });
        if (!gpuRes.ok) return;
        const gpuPayload = (await gpuRes.json()) as GpuStatsPayload;
        if (signal?.aborted) return;
        setGpuStatus(gpuPayload.status);
      } catch {
        // 静默：保留上次状态
      }
    },
    [range],
  );

  // 数据获取与自动刷新（range 变化即重建）：初次加载与定时刷新共用一个
  // AbortController——切窗时中止在途请求（旧窗迟到响应另有 range 标记兜底）。
  // 节奏：30m/2h 跟随用户选中的 intervalMs、24h/7d 恒 60s；不可见跳过，
  // 回到可见立即补拉。
  useEffect(() => {
    const controller = new AbortController();
    // 24h/7d 背后是分钟级/15 分钟级聚合桶，秒级轮询没有意义，恒 60s、不受
    // 选择器影响；30m/2h 才是"实时"档，跟随用户选中的 intervalMs
    const pollMs = range === "30m" || range === "2h" ? intervalMs : 60_000;
    const tick = () => {
      if (!document.hidden) void load(controller.signal);
    };
    const timer = setInterval(tick, pollMs);
    tick(); // 初次加载
    const onVisibility = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      controller.abort();
    };
  }, [load, range, intervalMs]);

  // ---- 派生数据（单序列卡直接抽稀；仅网络卡需要按 ts 归并两条同轴线）----

  const series = data?.series;
  const isLongRange = range === "24h" || range === "7d";

  const gpuMem = series?.[METRIC_IDS.gpuMemUsedMib] ?? [];
  const gpuUtil = series?.[METRIC_IDS.gpuUtilPercent] ?? [];
  // 不能只看序列空否：store 有 SQLite 聚合桶，GPU 降级后历史点仍在，会显示一条停滞曲线
  const gpuHidden = gpuStatus !== "available" || (gpuMem.length === 0 && gpuUtil.length === 0);
  const gpuMemRows = data ? buildChartRows(data, GPU_MEM_SPEC) : [];
  const gpuUtilRows = data ? buildChartRows(data, GPU_UTIL_SPEC) : [];

  const containerCpu = series?.[METRIC_IDS.containerCpuPercent] ?? [];
  const containerMem = series?.[METRIC_IDS.containerMemBytes] ?? [];
  const containerCpuRows = data ? buildChartRows(data, CONTAINER_CPU_SPEC) : [];
  const containerMemRows = data ? buildChartRows(data, CONTAINER_MEM_SPEC) : [];

  const hostCpu = series?.[METRIC_IDS.hostCpuPercent] ?? [];
  const hostMem = series?.[METRIC_IDS.hostMemUsedBytes] ?? [];
  const hostLoad = series?.[METRIC_IDS.hostLoad1] ?? [];
  const hostDisk = series?.[METRIC_IDS.hostDiskFreeBytes] ?? [];
  const hostNetRx = series?.[METRIC_IDS.hostNetRxBytesPerSec] ?? [];
  const hostNetTx = series?.[METRIC_IDS.hostNetTxBytesPerSec] ?? [];
  const hostCpuRows = data ? buildChartRows(data, HOST_CPU_SPEC) : [];
  const hostMemRows = data ? buildChartRows(data, HOST_MEM_SPEC) : [];
  const hostLoadRows = data ? buildChartRows(data, HOST_LOAD_SPEC) : [];
  const hostDiskRows = data ? buildChartRows(data, HOST_DISK_SPEC) : [];
  // 网络卡的 rx/tx 两条线共轴，需要按 ts 就近归并；tolerance 取决于 data
  // 分辨率（5s 内存 ring / 15m 聚合桶）。这里保留手写 mergeSeries 而不是
  // buildChartRows(data, HOST_NET_SPEC)，是因为 data 为 null 时 netTolerance
  // 需要一个兜底值——两条写法在 data 非空时结果完全一致，HOST_NET_SPEC
  // 只服务于弹层与本卡 props 透传
  const netTolerance = data ? toleranceFor(data.resolution) : 2_500;
  const hostNetRows: TwoLineRow[] = downsample(mergeSeries(hostNetRx, hostNetTx, netTolerance));

  const inferTokens = series?.[METRIC_IDS.inferTokensPerSec] ?? [];
  const inferSlots = series?.[METRIC_IDS.inferSlotsRunning] ?? [];
  const inferHidden = inferTokens.length === 0 && inferSlots.length === 0;
  const inferTokensRows = data ? buildChartRows(data, INFER_TOKENS_SPEC) : [];
  const inferSlotsRows = data ? buildChartRows(data, INFER_SLOTS_SPEC) : [];

  // ---- locale 时间格式（轴：短窗 HH:mm / 长窗 MM-dd HH:mm；tooltip 更精确）----

  const axisTimeFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(
        locale,
        isLongRange
          ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }
          : { hour: "2-digit", minute: "2-digit" },
      ),
    [locale, isLongRange],
  );
  const tooltipTimeFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(
        locale,
        isLongRange
          ? { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }
          : { hour: "2-digit", minute: "2-digit", second: "2-digit" },
      ),
    [locale, isLongRange],
  );

  // ---- 图例当前值 ----

  const gpuMemLatest = latestValue(gpuMem);
  const gpuUtilLatest = latestValue(gpuUtil);
  const containerCpuLatest = latestValue(containerCpu);
  const containerMemLatest = latestValue(containerMem);
  const hostCpuLatest = latestValue(hostCpu);
  const hostMemLatest = latestValue(hostMem);
  const hostLoadLatest = latestValue(hostLoad);
  const hostDiskLatest = latestValue(hostDisk);
  const hostNetRxLatest = latestValue(hostNetRx);
  const hostNetTxLatest = latestValue(hostNetTx);
  const tokensLatest = latestValue(inferTokens);
  const slotsLatest = latestValue(inferSlots);

  return (
    <>
      {/* 时间范围 Tabs + 加载失败提示：固定不滚动（shrink-0）——下方图卡区
          独立滚动，滚到第 9 张卡时还要能直接切时间范围，不用先滚回顶部 */}
      <div className="flex shrink-0 items-center gap-3">
        <h2 className="text-xs font-semibold tracking-tight text-muted-foreground">
          {t("chartsTitle")}
        </h2>
        {failed && <p className="text-xs text-destructive">{t("chartsLoadError")}</p>}
        <div className="flex-1" />
        <RefreshIntervalSelect />
        <Tabs
          value={range}
          onValueChange={(value) => {
            if (isRangeKey(value)) setRange(value);
          }}
        >
          <TabsList className="h-7 p-0.5">
            {RANGE_KEYS.map((key) => (
              <TabsTrigger key={key} value={key} className="h-6 px-2 font-mono text-[11px]">
                {key}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      {/* 图卡栅格 + 脚注一起滚动（脚注是图表的注解，不该单独占一块固定空间）；
          lg 以下栅格塌成单列，两个独立滚动区竖着叠在一起是反直觉的，滚动只在
          lg 起生效，窄屏仍整页滚动 */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:overflow-y-auto lg:pr-1">
        {/* 一卡一轴的响应式栅格：窄屏 1 列、中屏 2 列、宽屏 3 列（与
            monitoring/metric-cards.tsx 的统计格栅格惯例一致，断点按图卡内容
            比统计格更密，收窄一档：md 起 2 列、xl 起 3 列） */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {/* ---- 宿主机组（5 卡，恒渲染，各卡按自身序列独立判空态）---- */}
          <SeriesChartCard
            icon={Server}
            title={t("chartsHostCpuTitle")}
            legend={[
              {
                colorClass: "bg-chart-1",
                label: t("chartsCpu"),
                value: hostCpuLatest !== null ? formatPercent(hostCpuLatest) : null,
              },
            ]}
            rows={hostCpuRows}
            rowsSpec={HOST_CPU_SPEC}
            range={range}
            lines={[{ dataKey: "value", color: "var(--chart-1)", variant: "line", strokeWidth: 1.8 }]}
            tooltipLines={[
              { key: "value", label: t("chartsCpu"), format: formatPercent, colorClass: "bg-chart-1" },
            ]}
            timeFmt={tooltipTimeFmt}
            axisTimeFmt={axisTimeFmt}
            yAxis={{ unit: "%", width: 40 }}
            isEmpty={hostCpuRows.length === 0}
            emptyLabel={t("chartsEmpty")}
          />
          <SeriesChartCard
            icon={Server}
            title={t("chartsHostMemTitle")}
            legend={[
              {
                colorClass: "bg-chart-5",
                label: t("chartsMem"),
                value: hostMemLatest !== null ? formatSize(hostMemLatest) : null,
              },
            ]}
            rows={hostMemRows}
            rowsSpec={HOST_MEM_SPEC}
            range={range}
            lines={[{ dataKey: "value", color: "var(--chart-5)", variant: "line", strokeWidth: 1.8 }]}
            tooltipLines={[
              { key: "value", label: t("chartsMem"), format: formatSize, colorClass: "bg-chart-5" },
            ]}
            timeFmt={tooltipTimeFmt}
            axisTimeFmt={axisTimeFmt}
            yAxis={{ tickFormatter: formatBytesAxis, width: 44 }}
            isEmpty={hostMemRows.length === 0}
            emptyLabel={t("chartsEmpty")}
          />
          <SeriesChartCard
            icon={Server}
            title={t("chartsHostLoadTitle")}
            legend={[
              {
                colorClass: "bg-chart-3",
                label: t("chartsHostLoadTitle"),
                value: hostLoadLatest !== null ? formatLoad(hostLoadLatest) : null,
              },
            ]}
            rows={hostLoadRows}
            rowsSpec={HOST_LOAD_SPEC}
            range={range}
            lines={[{ dataKey: "value", color: "var(--chart-3)", variant: "line", strokeWidth: 1.8 }]}
            tooltipLines={[
              { key: "value", label: t("chartsHostLoadTitle"), format: formatLoad, colorClass: "bg-chart-3" },
            ]}
            timeFmt={tooltipTimeFmt}
            axisTimeFmt={axisTimeFmt}
            yAxis={{ tickFormatter: formatLoad, width: 34 }}
            isEmpty={hostLoadRows.length === 0}
            emptyLabel={t("chartsEmpty")}
          />
          <SeriesChartCard
            icon={Server}
            title={t("chartsHostDiskTitle")}
            legend={[
              {
                colorClass: "bg-chart-4",
                label: t("chartsHostDiskTitle"),
                value: hostDiskLatest !== null ? formatSize(hostDiskLatest) : null,
              },
            ]}
            rows={hostDiskRows}
            rowsSpec={HOST_DISK_SPEC}
            range={range}
            lines={[{ dataKey: "value", color: "var(--chart-4)", variant: "line", strokeWidth: 1.8 }]}
            tooltipLines={[
              { key: "value", label: t("chartsHostDiskTitle"), format: formatSize, colorClass: "bg-chart-4" },
            ]}
            timeFmt={tooltipTimeFmt}
            axisTimeFmt={axisTimeFmt}
            yAxis={{ tickFormatter: formatBytesAxis, width: 44 }}
            isEmpty={hostDiskRows.length === 0}
            emptyLabel={t("chartsEmpty")}
          />
          <SeriesChartCard
            icon={Server}
            title={t("chartsHostNetTitle")}
            legend={[
              {
                colorClass: "bg-chart-1",
                label: t("chartsHostNetRx"),
                value: hostNetRxLatest !== null ? formatBytesPerSec(hostNetRxLatest) : null,
              },
              {
                colorClass: "bg-chart-5",
                label: t("chartsHostNetTx"),
                value: hostNetTxLatest !== null ? formatBytesPerSec(hostNetTxLatest) : null,
              },
            ]}
            rows={hostNetRows}
            rowsSpec={HOST_NET_SPEC}
            range={range}
            lines={[
              { dataKey: "a", color: "var(--chart-1)", variant: "line", strokeWidth: 1.8 },
              { dataKey: "b", color: "var(--chart-5)", variant: "line", strokeWidth: 1.8 },
            ]}
            tooltipLines={[
              { key: "a", label: t("chartsHostNetRx"), format: formatBytesPerSec, colorClass: "bg-chart-1" },
              { key: "b", label: t("chartsHostNetTx"), format: formatBytesPerSec, colorClass: "bg-chart-5" },
            ]}
            timeFmt={tooltipTimeFmt}
            axisTimeFmt={axisTimeFmt}
            yAxis={{ tickFormatter: formatBytesAxisPerSec, width: 52 }}
            isEmpty={hostNetRows.length === 0}
            emptyLabel={t("chartsEmpty")}
          />

          {/* ---- GPU 组（2 卡，共用 gpuHidden：同源于一次 nvidia-smi 探测）---- */}
          <SeriesChartCard
            icon={Zap}
            title={t("chartsGpuMemTitle")}
            legend={[
              {
                colorClass: "bg-chart-1",
                label: t("chartsGpuMem"),
                value: gpuMemLatest !== null ? formatSize(gpuMemLatest * 1024 * 1024) : null,
              },
            ]}
            rows={gpuMemRows}
            rowsSpec={GPU_MEM_SPEC}
            range={range}
            lines={[
              { dataKey: "value", color: "var(--chart-1)", variant: "area", gradientId: "gpuMemFill", strokeWidth: 2 },
            ]}
            tooltipLines={[
              {
                key: "value",
                label: t("chartsGpuMem"),
                format: (v) => formatSize(v * 1024 * 1024),
                colorClass: "bg-chart-1",
              },
            ]}
            timeFmt={tooltipTimeFmt}
            axisTimeFmt={axisTimeFmt}
            yAxis={{ tickFormatter: formatMibAxis, width: 44 }}
            hidden={gpuHidden}
          />
          <SeriesChartCard
            icon={Zap}
            title={t("chartsGpuUtilTitle")}
            legend={[
              {
                colorClass: "bg-chart-5",
                label: t("chartsGpuUtil"),
                value: gpuUtilLatest !== null ? formatPercent(gpuUtilLatest) : null,
              },
            ]}
            rows={gpuUtilRows}
            rowsSpec={GPU_UTIL_SPEC}
            range={range}
            lines={[
              { dataKey: "value", color: "var(--chart-5)", variant: "line", strokeWidth: 1.5, strokeDasharray: "5 4" },
            ]}
            tooltipLines={[
              { key: "value", label: t("chartsGpuUtil"), format: formatPercent, colorClass: "bg-chart-5" },
            ]}
            timeFmt={tooltipTimeFmt}
            axisTimeFmt={axisTimeFmt}
            yAxis={{ domain: [0, 100], unit: "%", width: 34 }}
            hidden={gpuHidden}
          />

          {/* ---- 模型容器组（2 卡，恒渲染，各卡按自身序列独立判空态）---- */}
          <SeriesChartCard
            icon={Cpu}
            title={t("chartsContainerCpuTitle")}
            legend={[
              {
                colorClass: "bg-chart-1",
                label: t("chartsCpu"),
                value: containerCpuLatest !== null ? formatPercent(containerCpuLatest) : null,
              },
            ]}
            rows={containerCpuRows}
            rowsSpec={CONTAINER_CPU_SPEC}
            range={range}
            lines={[{ dataKey: "value", color: "var(--chart-1)", variant: "line", strokeWidth: 1.8 }]}
            tooltipLines={[
              { key: "value", label: t("chartsCpu"), format: formatPercent, colorClass: "bg-chart-1" },
            ]}
            timeFmt={tooltipTimeFmt}
            axisTimeFmt={axisTimeFmt}
            yAxis={{ unit: "%", width: 40 }}
            isEmpty={containerCpuRows.length === 0}
            emptyLabel={t("chartsEmpty")}
          />
          <SeriesChartCard
            icon={Cpu}
            title={t("chartsContainerMemTitle")}
            legend={[
              {
                colorClass: "bg-chart-5",
                label: t("chartsMem"),
                value: containerMemLatest !== null ? formatSize(containerMemLatest) : null,
              },
            ]}
            rows={containerMemRows}
            rowsSpec={CONTAINER_MEM_SPEC}
            range={range}
            lines={[{ dataKey: "value", color: "var(--chart-5)", variant: "line", strokeWidth: 1.8 }]}
            tooltipLines={[
              { key: "value", label: t("chartsMem"), format: formatSize, colorClass: "bg-chart-5" },
            ]}
            timeFmt={tooltipTimeFmt}
            axisTimeFmt={axisTimeFmt}
            yAxis={{ tickFormatter: formatBytesAxis, width: 44 }}
            isEmpty={containerMemRows.length === 0}
            emptyLabel={t("chartsEmpty")}
          />

          {/* ---- 推理组（2 卡，共用 inferHidden：同源于一次 /health+/slots 探测）---- */}
          <SeriesChartCard
            icon={Activity}
            title={t("chartsInferTokensTitle")}
            legend={[
              {
                colorClass: "bg-chart-2",
                label: t("chartsInferTokens"),
                value: tokensLatest !== null ? tokensLatest.toFixed(1) : null,
              },
            ]}
            rows={inferTokensRows}
            rowsSpec={INFER_TOKENS_SPEC}
            range={range}
            lines={[
              { dataKey: "value", color: "var(--chart-2)", variant: "area", gradientId: "inferTokensFill", strokeWidth: 1.8 },
            ]}
            tooltipLines={[
              {
                key: "value",
                label: t("chartsInferTokens"),
                format: (v) => v.toFixed(1),
                colorClass: "bg-chart-2",
              },
            ]}
            timeFmt={tooltipTimeFmt}
            axisTimeFmt={axisTimeFmt}
            yAxis={{ width: 40 }}
            hidden={inferHidden}
          />
          <SeriesChartCard
            icon={Activity}
            title={t("chartsInferSlotsTitle")}
            legend={[
              {
                colorClass: "bg-chart-4",
                label: t("chartsSlots"),
                value: slotsLatest !== null ? String(Math.round(slotsLatest)) : null,
              },
            ]}
            rows={inferSlotsRows}
            rowsSpec={INFER_SLOTS_SPEC}
            range={range}
            lines={[{ dataKey: "value", color: "var(--chart-4)", variant: "line", type: "stepAfter", strokeWidth: 1.5 }]}
            tooltipLines={[
              {
                key: "value",
                label: t("chartsSlots"),
                format: (v) => String(Math.round(v)),
                colorClass: "bg-chart-4",
              },
            ]}
            timeFmt={tooltipTimeFmt}
            axisTimeFmt={axisTimeFmt}
            yAxis={{ allowDecimals: false, width: 26 }}
            hidden={inferHidden}
          />
        </div>

        <p className="text-[11px] text-muted-foreground">{t("chartsFootnote")}</p>
      </div>
    </>
  );
}
