"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, Cpu, Zap } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatSize } from "@/lib/format";
import { METRIC_IDS } from "@/server/metrics/ids";
import { type GpuStatsPayload } from "@/server/metrics/latest";
import type { NvidiaStatus } from "@/server/metrics/nvidiaSmi";
import { RANGE_KEYS, type RangeKey, type WindowPayload, type WindowPoint } from "@/server/metrics/window";
import { apiFetch } from "@/lib/api";

/**
 * 概览页监控图表（M3 Task 4）：时间范围 Tabs + 三张 recharts 图卡。
 *
 * SSR 取舍：不用 next/dynamic——图表仅在 data 非空时渲染，而 data 只可能
 * 来自客户端 fetch（useEffect），SSR 首帧 data 恒为 null，recharts 不会
 * 在服务端执行（无 window 告警）；省掉一层动态加载边界，首屏更简单。
 *
 * 空态语义（与 window API 的"空数组=未采集"约定对应）：
 * - GPU 卡：按 gpuStatus 判隐藏（初值取 SSR 传入的 initialGpuStatus，随窗口
 *   轮询顺带刷新 /api/v1/gpu/stats 更新，与 monitoring/metric-cards 同构，
 *   M5 Task 4）。不能只看序列空否——SQLite 聚合桶留有历史点，GPU 降级后
 *   序列仍非空，若只按空数组判会显示一条停滞曲线不隐藏；也不能只用 SSR
 *   静态快照——面板重启后首帧若探测未完成会把 probing 误判为不可用，且无
 *   刷新入口时永不自愈
 * - 推理卡：两序列全空 → 整卡不渲染（health 不可得）
 * - 容器卡：恒渲染，无样本时显示空态文案（无容器运行是正常态）
 *
 * 自动刷新按档位：30m/2h 每 5s、24h/7d 每 60s；页面不可见时跳过
 * （回到可见立即补拉一次）。数据点 >500 时按步进采样抽稀防 recharts 卡顿。
 */

/** 单图渲染点数上限：超过即步进抽稀（保留末点，保证最新值在图上） */
const MAX_RENDER_POINTS = 500;

/** 序列点归并容差：同一采集 tick 的两指标 ts 通常相等，容差兜底毫秒级漂移 */
function toleranceFor(resolution: "5s" | "15m"): number {
  return resolution === "5s" ? 2_500 : 450_000;
}

/** 图表行：主序列值 a + 副序列值 b（按 ts 就近归并，缺失为 undefined） */
interface ChartRow {
  ts: number;
  a?: number;
  b?: number;
}

/** 两列各自升序的序列按 ts 就近归并（|Δ| ≤ tolerance 视为同一时刻） */
function mergeSeries(
  primary: WindowPoint[],
  secondary: WindowPoint[],
  tolerance: number,
): ChartRow[] {
  const rows: ChartRow[] = [];
  let i = 0;
  let j = 0;
  while (i < primary.length || j < secondary.length) {
    const pTs = i < primary.length ? primary[i].ts : Number.POSITIVE_INFINITY;
    const sTs = j < secondary.length ? secondary[j].ts : Number.POSITIVE_INFINITY;
    const ts = Math.min(pTs, sTs);
    const row: ChartRow = { ts };
    if (pTs - ts <= tolerance) {
      row.a = primary[i].value;
      i += 1;
    }
    if (sTs - ts <= tolerance) {
      row.b = secondary[j].value;
      j += 1;
    }
    rows.push(row);
  }
  return rows;
}

/** 步进采样抽稀：每隔 stride 取一点并强制保留末点 */
function downsample<T>(rows: T[]): T[] {
  if (rows.length <= MAX_RENDER_POINTS) return rows;
  const stride = Math.ceil(rows.length / MAX_RENDER_POINTS);
  const out = rows.filter((_, index) => index % stride === 0);
  const last = rows[rows.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/** 序列最新值（图例展示用；空序列 null） */
function latestValue(points: WindowPoint[] | undefined): number | null {
  if (!points || points.length === 0) return null;
  return points[points.length - 1].value;
}

/** 百分比展示：≥100 取整，否则一位小数 */
function formatPercent(value: number): string {
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)}%`;
}

/** MiB 轴刻度紧凑格式（6.1G / 512M） */
function formatMibAxis(mib: number): string {
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)}G` : `${Math.round(mib)}M`;
}

function isRangeKey(value: unknown): value is RangeKey {
  return typeof value === "string" && (RANGE_KEYS as readonly string[]).includes(value);
}

// ---------- 图例 / 空态小件 ----------

function LegendItem({
  colorClass,
  label,
  value,
}: {
  colorClass: string;
  label: string;
  value: string | null;
}) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <span aria-hidden className={`inline-block h-0.5 w-3 rounded-full ${colorClass}`} />
      <span>{label}</span>
      {value !== null && (
        <span className="font-mono tabular-nums text-foreground/80">{value}</span>
      )}
    </span>
  );
}

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

// ---------- tooltip ----------

/** tooltip 行配置：dataKey（a/b）→ 双语标签 + 值格式化 + 圆点色 */
interface TooltipLine {
  key: "a" | "b";
  label: string;
  format: (value: number) => string;
  colorClass: string;
}

function ChartTooltip({
  active,
  payload,
  timeFmt,
  lines,
}: {
  active?: boolean;
  payload?: { payload: ChartRow }[];
  timeFmt: Intl.DateTimeFormat;
  lines: TooltipLine[];
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return (
    <div className="max-w-56 rounded-lg border bg-popover px-2.5 py-1.5 text-xs shadow-md">
      <p className="font-mono tabular-nums text-muted-foreground">{timeFmt.format(row.ts)}</p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {lines.map((line) =>
          row[line.key] === undefined ? null : (
            <li key={line.key} className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5">
                <span aria-hidden className={`inline-block size-1.5 rounded-full ${line.colorClass}`} />
                {line.label}
              </span>
              <span className="font-mono tabular-nums">{line.format(row[line.key]!)}</span>
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

// ---------- 主组件 ----------

export function OverviewCharts({ initialGpuStatus }: { initialGpuStatus: NvidiaStatus }) {
  const t = useTranslations("pages.overview");
  const locale = useLocale();
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
  // 节奏：30m/2h 每 5s、24h/7d 每 60s；不可见跳过，回到可见立即补拉。
  useEffect(() => {
    const controller = new AbortController();
    const intervalMs = range === "30m" || range === "2h" ? 5_000 : 60_000;
    const tick = () => {
      if (!document.hidden) void load(controller.signal);
    };
    const timer = setInterval(tick, intervalMs);
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
  }, [load, range]);

  // ---- 派生数据（序列合并 + 抽稀）----

  const series = data?.series;
  const tolerance = data ? toleranceFor(data.resolution) : 2_500;
  const isLongRange = range === "24h" || range === "7d";

  const gpuMem = series?.[METRIC_IDS.gpuMemUsedMib] ?? [];
  const gpuUtil = series?.[METRIC_IDS.gpuUtilPercent] ?? [];
  // 不能只看序列空否：store 有 SQLite 聚合桶，GPU 降级后历史点仍在，会显示一条停滞曲线
  const gpuHidden = gpuStatus !== "available" || (gpuMem.length === 0 && gpuUtil.length === 0);
  const gpuRows = downsample(mergeSeries(gpuMem, gpuUtil, tolerance));

  const containerCpu = series?.[METRIC_IDS.containerCpuPercent] ?? [];
  const containerMem = series?.[METRIC_IDS.containerMemBytes] ?? [];
  const containerRows = downsample(mergeSeries(containerCpu, containerMem, tolerance));

  const inferTokens = series?.[METRIC_IDS.inferTokensPerSec] ?? [];
  const inferSlots = series?.[METRIC_IDS.inferSlotsRunning] ?? [];
  const inferHidden = inferTokens.length === 0 && inferSlots.length === 0;
  const inferRows = downsample(mergeSeries(inferTokens, inferSlots, tolerance));

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

  // 图例当前值
  const gpuMemLatest = latestValue(gpuMem);
  const gpuUtilLatest = latestValue(gpuUtil);
  const cpuLatest = latestValue(containerCpu);
  const memLatest = latestValue(containerMem);
  const tokensLatest = latestValue(inferTokens);
  const slotsLatest = latestValue(inferSlots);

  // tooltip 行配置（双语标签）
  const gpuTooltipLines: TooltipLine[] = [
    {
      key: "a",
      label: t("chartsGpuMem"),
      format: (v) => formatSize(v * 1024 * 1024),
      colorClass: "bg-chart-1",
    },
    {
      key: "b",
      label: t("chartsGpuUtil"),
      format: (v) => formatPercent(v),
      colorClass: "bg-chart-5",
    },
  ];
  const containerTooltipLines: TooltipLine[] = [
    {
      key: "a",
      label: t("chartsCpu"),
      format: (v) => formatPercent(v),
      colorClass: "bg-chart-1",
    },
    {
      key: "b",
      label: t("chartsMem"),
      format: (v) => formatSize(v),
      colorClass: "bg-chart-5",
    },
  ];
  const inferTooltipLines: TooltipLine[] = [
    {
      key: "a",
      label: t("chartsInferTokens"),
      format: (v) => v.toFixed(1),
      colorClass: "bg-chart-2",
    },
    {
      key: "b",
      label: t("chartsSlots"),
      format: (v) => String(Math.round(v)),
      colorClass: "bg-chart-4",
    },
  ];

  // 轴/网格公共样式（SVG 属性直接吃 CSS 变量，随主题自动切换）
  const axisTick = { fontSize: 11, fill: "var(--muted-foreground)" };
  const gridStroke = "var(--border)";

  return (
    <>
      {/* 时间范围 Tabs + 加载失败提示 */}
      <div className="flex items-center gap-3">
        <h2 className="text-xs font-semibold tracking-tight text-muted-foreground">
          {t("chartsTitle")}
        </h2>
        {failed && <p className="text-xs text-destructive">{t("chartsLoadError")}</p>}
        <div className="flex-1" />
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

      {/* GPU：显存面积 + 利用率副线；status 非 available 或两序列皆空 → 整卡隐藏 */}
      {!gpuHidden && (
        <Card>
          <CardContent>
            <ChartCardHeader icon={Zap} title={t("chartsGpuTitle")}>
              <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[11px] text-muted-foreground">
                <LegendItem
                  colorClass="bg-chart-1"
                  label={t("chartsGpuMem")}
                  value={gpuMemLatest !== null ? formatSize(gpuMemLatest * 1024 * 1024) : null}
                />
                <LegendItem
                  colorClass="bg-chart-5"
                  label={t("chartsGpuUtil")}
                  value={gpuUtilLatest !== null ? formatPercent(gpuUtilLatest) : null}
                />
              </div>
            </ChartCardHeader>
            <div className="mt-2 h-56">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={gpuRows} margin={{ top: 6, right: 2, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="gpuMemFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.25} />
                      <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.04} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={gridStroke} strokeDasharray="3 5" vertical={false} />
                  <XAxis
                    dataKey="ts"
                    type="number"
                    scale="time"
                    domain={["dataMin", "dataMax"]}
                    tickFormatter={(ts: number) => axisTimeFmt.format(ts)}
                    tick={axisTick}
                    axisLine={{ stroke: gridStroke }}
                    tickLine={false}
                    minTickGap={32}
                  />
                  <YAxis
                    yAxisId="mem"
                    width={44}
                    tickFormatter={(v: number) => formatMibAxis(v)}
                    tick={axisTick}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    yAxisId="util"
                    orientation="right"
                    domain={[0, 100]}
                    unit="%"
                    width={34}
                    tick={axisTick}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    cursor={{ stroke: gridStroke, strokeDasharray: "3 3" }}
                    content={<ChartTooltip timeFmt={tooltipTimeFmt} lines={gpuTooltipLines} />}
                  />
                  <Area
                    yAxisId="mem"
                    dataKey="a"
                    type="monotone"
                    stroke="var(--chart-1)"
                    strokeWidth={2}
                    fill="url(#gpuMemFill)"
                    connectNulls
                    dot={false}
                    isAnimationActive={false}
                  />
                  <Line
                    yAxisId="util"
                    dataKey="b"
                    type="monotone"
                    stroke="var(--chart-5)"
                    strokeWidth={1.5}
                    strokeDasharray="5 4"
                    connectNulls
                    dot={false}
                    isAnimationActive={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 容器：CPU% + 内存双线；无容器运行是正常态 → 空态卡而非隐藏 */}
      <Card>
        <CardContent>
          <ChartCardHeader icon={Cpu} title={t("chartsContainerTitle")}>
            <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[11px] text-muted-foreground">
              <LegendItem
                colorClass="bg-chart-1"
                label={t("chartsCpu")}
                value={cpuLatest !== null ? formatPercent(cpuLatest) : null}
              />
              <LegendItem
                colorClass="bg-chart-5"
                label={t("chartsMem")}
                value={memLatest !== null ? formatSize(memLatest) : null}
              />
            </div>
          </ChartCardHeader>
          {containerRows.length === 0 ? (
            <div className="flex h-44 items-center justify-center text-xs text-muted-foreground">
              {t("chartsEmpty")}
            </div>
          ) : (
            <div className="mt-2 h-44">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={containerRows} margin={{ top: 6, right: 2, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={gridStroke} strokeDasharray="3 5" vertical={false} />
                  <XAxis
                    dataKey="ts"
                    type="number"
                    scale="time"
                    domain={["dataMin", "dataMax"]}
                    tickFormatter={(ts: number) => axisTimeFmt.format(ts)}
                    tick={axisTick}
                    axisLine={{ stroke: gridStroke }}
                    tickLine={false}
                    minTickGap={32}
                  />
                  <YAxis
                    yAxisId="cpu"
                    unit="%"
                    width={40}
                    tick={axisTick}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    yAxisId="mem"
                    orientation="right"
                    width={44}
                    tickFormatter={(v: number) => formatMibAxis(v)}
                    tick={axisTick}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    cursor={{ stroke: gridStroke, strokeDasharray: "3 3" }}
                    content={<ChartTooltip timeFmt={tooltipTimeFmt} lines={containerTooltipLines} />}
                  />
                  <Line
                    yAxisId="cpu"
                    dataKey="a"
                    type="monotone"
                    stroke="var(--chart-1)"
                    strokeWidth={1.8}
                    connectNulls
                    dot={false}
                    isAnimationActive={false}
                  />
                  <Line
                    yAxisId="mem"
                    dataKey="b"
                    type="monotone"
                    stroke="var(--chart-5)"
                    strokeWidth={1.8}
                    connectNulls
                    dot={false}
                    isAnimationActive={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 推理：tok/s 面积 + slots 阶梯副线；health 不可得（两序列空）→ 整卡隐藏 */}
      {!inferHidden && (
        <Card>
          <CardContent>
            <ChartCardHeader icon={Activity} title={t("chartsInferTitle")}>
              <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[11px] text-muted-foreground">
                <LegendItem
                  colorClass="bg-chart-2"
                  label={t("chartsInferTokens")}
                  value={tokensLatest !== null ? tokensLatest.toFixed(1) : null}
                />
                <LegendItem
                  colorClass="bg-chart-4"
                  label={t("chartsSlots")}
                  value={slotsLatest !== null ? String(Math.round(slotsLatest)) : null}
                />
              </div>
            </ChartCardHeader>
            <div className="mt-2 h-44">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={inferRows} margin={{ top: 6, right: 2, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="inferTokensFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--chart-2)" stopOpacity={0.25} />
                      <stop offset="100%" stopColor="var(--chart-2)" stopOpacity={0.04} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={gridStroke} strokeDasharray="3 5" vertical={false} />
                  <XAxis
                    dataKey="ts"
                    type="number"
                    scale="time"
                    domain={["dataMin", "dataMax"]}
                    tickFormatter={(ts: number) => axisTimeFmt.format(ts)}
                    tick={axisTick}
                    axisLine={{ stroke: gridStroke }}
                    tickLine={false}
                    minTickGap={32}
                  />
                  <YAxis
                    yAxisId="tokens"
                    width={40}
                    tick={axisTick}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    yAxisId="slots"
                    orientation="right"
                    allowDecimals={false}
                    width={26}
                    tick={axisTick}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    cursor={{ stroke: gridStroke, strokeDasharray: "3 3" }}
                    content={<ChartTooltip timeFmt={tooltipTimeFmt} lines={inferTooltipLines} />}
                  />
                  <Area
                    yAxisId="tokens"
                    dataKey="a"
                    type="monotone"
                    stroke="var(--chart-2)"
                    strokeWidth={1.8}
                    fill="url(#inferTokensFill)"
                    connectNulls
                    dot={false}
                    isAnimationActive={false}
                  />
                  <Line
                    yAxisId="slots"
                    dataKey="b"
                    type="stepAfter"
                    stroke="var(--chart-4)"
                    strokeWidth={1.5}
                    connectNulls
                    dot={false}
                    isAnimationActive={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}

      <p className="text-[11px] text-muted-foreground">{t("chartsFootnote")}</p>
    </>
  );
}
