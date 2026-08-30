"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Cpu,
  Database,
  Gauge,
  HardDrive,
  Layers,
  MemoryStick,
  Network,
  Server,
  Zap,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";

import { Card, CardContent } from "@/components/ui/card";
import { RefreshIntervalSelect } from "@/components/refresh-interval-select";
import { formatSize } from "@/lib/format";
import {
  type ContainerStatsPayload,
  type GpuStatsPayload,
  type HostStatsPayload,
  type LatestSample,
} from "@/server/metrics/latest";
import { METRIC_IDS } from "@/server/metrics/ids";
import type { GpuDevice, NvidiaStatus } from "@/server/metrics/nvidiaSmi";
import { type WindowPayload, type WindowPoint } from "@/server/metrics/window";
import { apiFetch } from "@/lib/api";
import { mergeWindowPayload, windowUrl } from "@/lib/metrics-window-merge";
import { useRefreshInterval } from "@/lib/use-refresh-interval";

/**
 * 监控页指标卡网格（M3 Task 5；G4 补宿主机卡）：每卡 = 当前值大数字 + 单位 +
 * 30m sparkline 迷你面积图。数据两路：
 * - 当前值：/api/v1/container/stats + /api/v1/gpu/stats + /api/v1/host/stats，
 *   轮询间隔由页顶 RefreshIntervalSelect 选择（默认 5s，记在 localStorage，见
 *   lib/refresh-interval.ts）——页面不可见跳过，回到可见立即补拉——与概览
 *   图表同款节拍
 * - sparkline：/api/v1/metrics/window?range=30m 只取对应序列末 60 点，30s 刷新
 *
 * GPU 三态（M5 Task 4）：gpu/stats 的 status 区分 probing（探测中，面板刚
 * 重启的窗口期）/ unavailable（确认不可用）/ available。探测中既不显示
 * GPU 卡也不出提示条（避免首帧误报"不可用"）；只有确认不可用才出页顶
 * 提示条说明需 --gpus 部署（M4 真机联调）。宿主机卡没有这种三态——os 系统调用
 * 或 /proc 读取失败只是单个字段缺席（显示 —），不是整块功能性降级，因此恒渲染，
 * 不参与 GPU 那套隐藏/提示条逻辑。
 * SSR 取舍同 overview-charts：图表仅在有数据时渲染，首帧恒空不触 recharts
 * 服务端执行。
 *
 * 副标行（T4 缺分母补齐，G4 沿用同一做法补宿主机卡）：CPU 卡的核数、内存卡的
 * 占用率、GPU 显存卡的 used/total 与温度/功耗、宿主机卡的核数/内存总量/
 * 磁盘总量，都是给大数字补"分母"——1247% 的 CPU 占用率不知道这台机器几核，
 * 6.1GiB 显存不知道装不装得下下一个模型。数据随 container/stats、gpu/stats、
 * host/stats 三个既有接口一起下发，不新增请求。GPU 温度取各卡 max（最热的卡
 * 是瓶颈），功耗取 sum（供电视角）；某字段所有卡都缺失时对应分段不显示。
 *
 * 宿主机磁盘/网络卡（追加需求）：磁盘卡与概览页右栏"磁盘"卡是两个不同的数——
 * 那里的"已用"是 models 目录树扫描求和，这里的"剩余"是 statfs 报告的整个
 * 分区剩余空间（包含 models 之外的占用），两者不能互相替代，因此保留独立
 * 展示而非合并。网络只留一张卡（rx 为主数字、tx 为副标），不拆成两张——
 * 二者总是成对出现，拆开反而占用两倍网格位置却没有额外信息量。
 */

/** sparkline 保留点数（30m @5s ≈ 360 点，取末 60 点 ≈ 最近 5 分钟） */
const SPARK_POINTS = 60;

/** sparkline 刷新间隔（窗口查询含 15min 桶降源，无需跟当前值节拍走）；
 *  当前值轮询间隔改用户可选（见 RefreshIntervalSelect），不再是固定常量 */
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

/** 百分比转纯文本（副标行拼接用，不需要 value/unit 分离展示） */
function percentText(v: number): string {
  const p = formatPercent(v);
  return `${p.value}${p.unit}`;
}

/** GPU 显存 used/total 的 GiB 数值：固定按 GiB 对齐两个数字的量纲
 * （显卡显存几乎不会落在 MiB 量级，不必像 formatMib 那样按量级切换单位） */
function toGib(mib: number): string {
  return (mib / 1024).toFixed(1);
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

/** 字节/秒速率展示：复用 formatSize 换算量级（KB/MB/GB 三档），拼上 "/s"。
 * formatSize 对 <=0 返回 "—"（无量纲可拆），网络速率的 0（网卡空闲）
 * 更适合显示 "0.0 KB/s" 而非 "—"——那意味着"没测到"，不是"确实是 0" */
function formatBytesPerSec(bytesPerSec: number): CardValue {
  if (bytesPerSec <= 0) return { value: "0.0", unit: "KB/s" };
  const [value, unit] = formatSize(bytesPerSec).split(" ");
  return { value: value ?? "0.0", unit: `${unit ?? "KB"}/s` };
}

/** 卡片定义：指标 id + 图标 + i18n 键 + sparkline 色 + 值格式化。
 * source 决定读哪个 stats 接口的 samples（container/gpu/host 三选一） */
interface CardDef {
  key: string;
  metric: string;
  source: "container" | "gpu" | "host";
  icon: typeof Cpu;
  labelKey:
    | "cardCpu"
    | "cardMem"
    | "cardTokensPerSec"
    | "cardKvCache"
    | "cardSlots"
    | "cardGpuMem"
    | "cardGpuUtil"
    | "cardHostCpu"
    | "cardHostMem"
    | "cardHostDisk"
    | "cardHostNet";
  colorVar: string;
  format: (v: number) => CardValue;
  /** sparkline 点预处理（bytes → MiB 等） */
  transform?: (v: number) => number;
}

const CARD_DEFS: CardDef[] = [
  {
    key: "cpu",
    metric: METRIC_IDS.containerCpuPercent,
    source: "container",
    icon: Cpu,
    labelKey: "cardCpu",
    colorVar: "var(--chart-1)",
    format: formatPercent,
  },
  {
    key: "mem",
    metric: METRIC_IDS.containerMemBytes,
    source: "container",
    icon: MemoryStick,
    labelKey: "cardMem",
    colorVar: "var(--chart-5)",
    format: (v) => formatMib(v / 1024 / 1024),
    transform: (v) => v / 1024 / 1024,
  },
  {
    key: "tps",
    metric: METRIC_IDS.inferTokensPerSec,
    source: "container",
    icon: Activity,
    labelKey: "cardTokensPerSec",
    colorVar: "var(--chart-2)",
    format: (v) => ({ value: v.toFixed(1), unit: "tok/s" }),
  },
  {
    key: "kv",
    metric: METRIC_IDS.inferKvCacheTokens,
    source: "container",
    icon: Database,
    labelKey: "cardKvCache",
    colorVar: "var(--chart-3)",
    format: formatTokensCompact,
  },
  {
    key: "slots",
    metric: METRIC_IDS.inferSlotsRunning,
    source: "container",
    icon: Layers,
    labelKey: "cardSlots",
    colorVar: "var(--chart-4)",
    format: (v) => ({ value: String(Math.round(v)), unit: "" }),
  },
  {
    key: "gpuMem",
    metric: METRIC_IDS.gpuMemUsedMib,
    source: "gpu",
    icon: Zap,
    labelKey: "cardGpuMem",
    colorVar: "var(--chart-1)",
    format: formatMib,
  },
  {
    key: "gpuUtil",
    metric: METRIC_IDS.gpuUtilPercent,
    source: "gpu",
    icon: Gauge,
    labelKey: "cardGpuUtil",
    colorVar: "var(--chart-5)",
    format: formatPercent,
  },
  {
    key: "hostCpu",
    metric: METRIC_IDS.hostCpuPercent,
    source: "host",
    icon: Server,
    labelKey: "cardHostCpu",
    colorVar: "var(--chart-1)",
    format: formatPercent,
  },
  {
    key: "hostMem",
    metric: METRIC_IDS.hostMemUsedBytes,
    source: "host",
    icon: MemoryStick,
    labelKey: "cardHostMem",
    colorVar: "var(--chart-5)",
    format: (v) => formatMib(v / 1024 / 1024),
    transform: (v) => v / 1024 / 1024,
  },
  {
    key: "hostDisk",
    metric: METRIC_IDS.hostDiskFreeBytes,
    source: "host",
    icon: HardDrive,
    labelKey: "cardHostDisk",
    colorVar: "var(--chart-3)",
    format: (v) => formatMib(v / 1024 / 1024),
    transform: (v) => v / 1024 / 1024,
  },
  {
    key: "hostNet",
    metric: METRIC_IDS.hostNetRxBytesPerSec,
    source: "host",
    icon: Network,
    labelKey: "cardHostNet",
    colorVar: "var(--chart-2)",
    format: formatBytesPerSec,
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

function MetricCard({ def, sample, spark, mainOverride, subtitle, titleSuffix, titleHint }: {
  def: CardDef;
  sample: LatestSample | undefined;
  spark: WindowPoint[];
  /** 大数字覆盖值（如 GPU 显存卡的 used/total 形式）；不传则用 def.format(sample.value) */
  mainOverride?: CardValue;
  /** 大数字下方、sparkline 上方的副标行；undefined 时整行不渲染（不留空占位） */
  subtitle?: string;
  /** 标题文本后缀（多卡 ×N 标识） */
  titleSuffix?: string;
  /** 卡片整体的 title 属性（多卡合计说明等） */
  titleHint?: string;
}) {
  const t = useTranslations("pages.monitoring");
  const shown = mainOverride ?? (sample !== undefined ? def.format(sample.value) : null);
  const Icon = def.icon;

  return (
    <Card size="sm" title={titleHint}>
      <CardContent>
        <div className="flex items-center gap-1.5 text-xs font-semibold">
          <Icon className="size-3.5 text-muted-foreground" />
          {t(def.labelKey)}
          {titleSuffix}
        </div>
        <div className="mt-1 flex items-baseline gap-1.5">
          <span className="font-mono text-xl leading-tight font-bold tabular-nums">
            {shown?.value ?? "—"}
          </span>
          {shown !== null && shown.unit !== "" && (
            <span className="text-xs text-muted-foreground">{shown.unit}</span>
          )}
        </div>
        {subtitle !== undefined && (
          <div className="mt-1 text-xs text-muted-foreground">{subtitle}</div>
        )}
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
  const { intervalMs } = useRefreshInterval();
  const [containerStats, setContainerStats] = useState<ContainerStatsPayload | null>(null);
  const [gpuStatus, setGpuStatus] = useState<NvidiaStatus>(initialGpuStatus);
  const [gpuSamples, setGpuSamples] = useState<{ [metric: string]: LatestSample } | null>(
    initialGpuStatus === "available" ? {} : null,
  );
  /** 分卡明细与显存汇总（T4 新增）：首帧未拉到数据前给安全默认值，
   * 空数组/null 时各卡副标行按"整行不渲染"处理，不会闪现假数据 */
  const [gpuDevices, setGpuDevices] = useState<GpuDevice[]>([]);
  const [gpuTotals, setGpuTotals] = useState<{ memUsedMib: number; memTotalMib: number } | null>(
    null,
  );
  const [statsFailed, setStatsFailed] = useState(false);
  const [spark, setSpark] = useState<WindowPayload | null>(null);
  /** spark 的镜像，供 loadSpark 内部读取：理由同 overview-charts.tsx——
   *  range 恒为 "30m"，这里没有切档场景，但同样不能让 loadSpark 依赖
   *  spark state（否则依赖数组每 tick 都变，定时器每 tick 重建） */
  const sparkRef = useRef<WindowPayload | null>(null);
  /** 宿主机指标（G4）：没有三态概念，首值给 null，卡片按 sample undefined 处理（显示 —） */
  const [hostStats, setHostStats] = useState<HostStatsPayload | null>(null);

  const loadStats = useCallback(async (signal?: AbortSignal) => {
    try {
      const [container, gpu, host] = await Promise.all([
        apiFetch("/api/v1/container/stats", { signal, cache: "no-store" }),
        apiFetch("/api/v1/gpu/stats", { signal, cache: "no-store" }),
        apiFetch("/api/v1/host/stats", { signal, cache: "no-store" }),
      ]);
      if (!container.ok || !gpu.ok || !host.ok) throw new Error("stats http error");
      setContainerStats((await container.json()) as ContainerStatsPayload);
      const gpuPayload = (await gpu.json()) as GpuStatsPayload;
      setGpuStatus(gpuPayload.status);
      setGpuSamples(gpuPayload.samples ?? {});
      setGpuDevices(gpuPayload.devices);
      setGpuTotals(gpuPayload.totals);
      setHostStats((await host.json()) as HostStatsPayload);
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
      const prevPayload = sparkRef.current;
      const res = await apiFetch(windowUrl("30m", prevPayload), { signal, cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const incoming = (await res.json()) as WindowPayload;
      const merged = mergeWindowPayload(prevPayload, incoming);
      sparkRef.current = merged;
      setSpark(merged);
    } catch {
      // sparkline 失败静默：当前值照常轮询，卡片只少一条趋势线；since 水位
      // 不前进，理由同 overview-charts.tsx 的 load，不需要额外处理
    }
  }, []);

  // 当前值轮询，间隔用户可选（visibility 暂停，回到可见立即补拉；间隔切换时
  // 重建定时器——依赖数组含 intervalMs，与 overview-charts 切换 range 同构）
  useEffect(() => {
    const controller = new AbortController();
    const tick = () => {
      if (!document.hidden) void loadStats(controller.signal);
    };
    const timer = setInterval(tick, intervalMs);
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
  }, [loadStats, intervalMs]);

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

  // CPU 卡副标：几核 + 满载基准，给"1247%"这类数字补分母；未采到核数（cpuCount
  // 为 null）整行不渲染，不留"N 核"的空占位
  const cpuCount = containerStats?.cpuCount ?? null;
  const cpuSubtitle =
    cpuCount !== null ? t("cardCpuSub", { count: cpuCount, max: cpuCount * 100 }) : undefined;

  // 内存卡副标：直接复用早已入库、UI 侧此前零引用的 container.mem_percent
  const memPercentSample = containerStats?.samples[METRIC_IDS.containerMemPercent];
  const memSubtitle = memPercentSample !== undefined ? percentText(memPercentSample.value) : undefined;

  // GPU 显存卡：totals 缺失或 memTotalMib 为 0（老驱动查不到 total）时主数字
  // 退化为现状单值——mainOverride 留 undefined，MetricCard 自动落回 def.format(sample.value)
  const gpuHasTotal = gpuTotals !== null && gpuTotals.memTotalMib > 0;
  const gpuMemMain: CardValue | undefined = gpuHasTotal
    ? { value: `${toGib(gpuTotals.memUsedMib)} / ${toGib(gpuTotals.memTotalMib)}`, unit: "GiB" }
    : undefined;

  // 副标三段：占用率（依赖 totals）+ 温度取 max（最热的卡是瓶颈）+ 功耗取 sum
  // （供电视角）；某段全卡都是 null 就不拼这段，全部缺失则整行不渲染
  const gpuMemSubtitleParts: string[] = [];
  if (gpuHasTotal) {
    gpuMemSubtitleParts.push(percentText((gpuTotals.memUsedMib / gpuTotals.memTotalMib) * 100));
  }
  const gpuTemps = gpuDevices.map((d) => d.tempC).filter((v): v is number => v !== null);
  if (gpuTemps.length > 0) gpuMemSubtitleParts.push(`${Math.round(Math.max(...gpuTemps))}°C`);
  const gpuPowers = gpuDevices.map((d) => d.powerW).filter((v): v is number => v !== null);
  if (gpuPowers.length > 0) {
    gpuMemSubtitleParts.push(`${Math.round(gpuPowers.reduce((sum, p) => sum + p, 0))}W`);
  }
  const gpuMemSubtitle = gpuMemSubtitleParts.length > 0 ? gpuMemSubtitleParts.join(" · ") : undefined;

  // 多卡标识：≥2 张卡才加 ×N 与合计说明，单卡场景保持原样
  const gpuMulti = gpuDevices.length >= 2;
  const gpuTitleSuffix = gpuMulti ? ` ×${gpuDevices.length}` : undefined;
  const gpuTitleHint = gpuMulti ? t("gpuMultiHint", { count: gpuDevices.length }) : undefined;

  // 宿主机卡副标（G4）：三个分母（核数/内存总量/磁盘总量）随 host/stats 一起下发，
  // 与容器 CPU/GPU 显存卡同款"缺分母不渲染整行"处理——没有三态，只是数据未到位。
  // CPU 卡副标模板与容器卡共用同一 i18n 键（cardCpuSub 本就是"{count} 核 · 满载
  // {max}%"，不含"容器"字样，语义对两者都成立，没必要另开一个冗余键）。
  const hostCpuCount = hostStats?.hostCpuCount ?? null;
  const hostCpuSubtitle =
    hostCpuCount !== null ? t("cardCpuSub", { count: hostCpuCount, max: hostCpuCount * 100 }) : undefined;

  const hostMemTotal = hostStats?.hostMemTotalBytes ?? null;
  const hostMemPercentSample = hostStats?.samples[METRIC_IDS.hostMemPercent];
  const hostMemSubtitle =
    hostMemPercentSample !== undefined && hostMemTotal !== null
      ? t("cardHostMemSub", { percent: percentText(hostMemPercentSample.value), total: formatSize(hostMemTotal) })
      : undefined;

  const hostDiskTotal = hostStats?.hostDiskTotalBytes ?? null;
  const hostDiskSubtitle =
    hostDiskTotal !== null ? t("cardHostDiskSub", { total: formatSize(hostDiskTotal) }) : undefined;

  // 网络卡副标：tx 速率带上行箭头——rx/tx 总是成对出现，箭头符号不分语言，不必走 i18n
  const hostNetTxSample = hostStats?.samples[METRIC_IDS.hostNetTxBytesPerSec];
  const hostNetSubtitle =
    hostNetTxSample !== undefined
      ? (() => {
          const tx = formatBytesPerSec(hostNetTxSample.value);
          return `↑ ${tx.value} ${tx.unit}`;
        })()
      : undefined;

  // 各卡副标/主数字覆盖按 key 查表传入，不拆散 CARD_DEFS 静态表结构
  const cardExtras: {
    [key: string]: {
      subtitle?: string;
      mainOverride?: CardValue;
      titleSuffix?: string;
      titleHint?: string;
    };
  } = {
    cpu: { subtitle: cpuSubtitle },
    mem: { subtitle: memSubtitle },
    gpuMem: {
      subtitle: gpuMemSubtitle,
      mainOverride: gpuMemMain,
      titleSuffix: gpuTitleSuffix,
      titleHint: gpuTitleHint,
    },
    hostCpu: { subtitle: hostCpuSubtitle },
    hostMem: { subtitle: hostMemSubtitle },
    hostDisk: { subtitle: hostDiskSubtitle },
    hostNet: { subtitle: hostNetSubtitle },
  };

  return (
    <section className="flex flex-col gap-3">
      {/* 工具条：标题由二级栏的 PageHeader 承载（页面标题已是「指标」，
          这里再写一次「指标卡」是同屏重复），本行只留失败提示与刷新间隔 */}
      <div className="flex items-center gap-3">
        {statsFailed && <p className="text-xs text-destructive">{t("loadError")}</p>}
        <div className="flex-1" />
        <RefreshIntervalSelect />
      </div>

      {/* 确认不可用（非探测中）：隐藏 GPU 两卡，页顶提示条说明部署要求 */}
      {showGpuHint && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          {t("gpuHint")}
        </p>
      )}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
        {CARD_DEFS.filter((def) => def.source !== "gpu" || !gpuHidden).map((def) => {
          const extra = cardExtras[def.key];
          const sample =
            def.source === "gpu"
              ? (gpuSamples?.[def.metric] ?? undefined)
              : def.source === "host"
                ? (hostStats?.samples[def.metric] ?? undefined)
                : (containerStats?.samples[def.metric] ?? undefined);
          return (
            <MetricCard
              key={def.key}
              def={def}
              sample={sample}
              spark={spark?.series[def.metric] ?? []}
              mainOverride={extra?.mainOverride}
              subtitle={extra?.subtitle}
              titleSuffix={extra?.titleSuffix}
              titleHint={extra?.titleHint}
            />
          );
        })}
      </div>
    </section>
  );
}
