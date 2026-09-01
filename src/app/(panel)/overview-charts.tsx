"use client";

import { useMemo } from "react";
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
import { useLocale, useTranslations } from "next-intl";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RefreshIntervalSelect } from "@/components/refresh-interval-select";
import { formatSize } from "@/lib/format";
import { buildChartRows, formatBytesAxis, formatMibAxis, formatPercent, type ChartRowsSpec } from "@/lib/chart-format";
import {
  cpuCoresSub,
  formatBytesPerSec as cardBytesPerSec,
  formatMib as cardFormatMib,
  formatPercent as cardFormatPercent,
  formatTokensCompact,
  gpuMaxTempC,
  gpuMemMain,
  gpuMemPercentText,
  gpuTotalPowerW,
  percentText,
  type CardValue,
} from "@/lib/metric-card-value";
import { METRIC_IDS } from "@/server/metrics/ids";
import { RANGE_KEYS, type RangeKey, type WindowPayload } from "@/server/metrics/window";
import type { NvidiaStatus } from "@/server/metrics/nvidiaSmi";
import { OverviewCard } from "./overview-card";
import { useOverviewStats } from "./use-overview-stats";
import { useOverviewWindow } from "./use-overview-window";

/**
 * 概览页监控合卡（任务 13：监控页「指标」组与本页图表 10/11 项重合，D1 定
 * 「搬到概览页，但重合的指标不许出现两次」——落地形态是「读数 + 曲线合成
 * 一张卡」，不是两块堆叠。每卡 = 卡头（图标 + 标题 + 当前值大数字 + 分母
 * 副标）+ 历史曲线（跟随页面 range 档位）+ 放大入口；宿主机磁盘剩余是唯一
 * 例外——D2：变化太慢，折线看不出东西，降级为只有卡头读数，没有曲线也没有
 * 放大入口。
 *
 * 两路数据，节拍不同、来源不同（拆成 use-overview-window.ts / use-overview
 * -stats.ts 两个 hook，本文件只管把两路数据拼进每张卡的 props）：
 * - 卡头「当前值大数字」：container/gpu/host 三个 stats 接口的最新样本，
 *   跟随页顶 RefreshIntervalSelect 选中的间隔（与 range 档位无关——哪怕
 *   正在看 7d 档的历史曲线，卡头也该是这一刻的读数，不是 15 分钟聚合桶里
 *   的旧值）
 * - 曲线历史：/api/v1/metrics/window，跟随 range 档位降源（30m/2h 走内存
 *   ring、24h/7d 走 15min 聚合桶），30m 档首帧由 (panel)/page.tsx 服务端
 *   直查 store 播种，不再空等一个 RTT（任务 11 步骤 3）
 *
 * 空态语义（与 window API 的"空数组=未采集"约定对应，按分组处理，同组卡
 * 一起隐藏/一起空——避免"一张卡有数据、同组另一张空着还占位"的割裂感）：
 * - GPU 组（显存 / 利用率两卡）：按 gpuStatus 判隐藏（初值取 SSR 传入的
 *   initialGpuStatus，随 stats 轮询顺带刷新）。不能只看序列空否——SQLite
 *   聚合桶留有历史点，GPU 降级后序列仍非空，若只按空数组判会显示一条停滞
 *   曲线不隐藏；也不能只用 SSR 静态快照——面板重启后首帧若探测未完成会把
 *   probing 误判为不可用，且无刷新入口时永不自愈
 * - 推理组（生成速率 / KV Cache / 活跃槽位三卡）：隐藏判据沿用改造前的
 *   "tokens 与 slots 两序列全空"（两者同源于一次 /health+/slots 探测），
 *   KV Cache 是这次合卡新补的第三张卡，共用同一个判据而不是自己再起一套——
 *   三者本就同源于同一次探测，没有必要为新卡单独判空
 * - 宿主机组（CPU/内存/负载/磁盘剩余/磁盘 IO/网络收发六卡）与容器组
 *   （CPU/内存两卡）：每卡按自己的序列独立判空态文案，不共享判据——这些
 *   指标虽同源于同一次采集 tick，但语义上互相独立（缺 CPU 不代表磁盘统计
 *   也失败），拆开前"卡片恒渲染，无样本时显示空态文案"就是这个策略，拆开
 *   后原样沿用到每一张卡
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

// 宿主机网络收发 / 磁盘 IO / 负载卡的曲线格式化：不依赖 props/state 的纯
// 换算，提到模块作用域，字节/秒的换算与拼接只在这一处，tooltip 与轴刻度
// 共用，避免多处各写一遍 "/s" 拼接。注意这三个函数服务于图表层（recharts
// 的 tooltip/tickFormatter 只吃 (value:number)=>string），与 lib/metric-
// card-value.ts 里同名的卡头层格式化器（返回 { value, unit } 供大数字/
// 单位分两处渲染）不是一回事，因此下面 import 时给卡头层的加了 card 前缀
// 别名，避免同名遮蔽。
function formatBytesPerSec(v: number): string {
  return `${formatSize(v)}/s`;
}
function formatBytesAxisPerSec(v: number): string {
  return `${formatBytesAxis(v)}/s`;
}
function formatLoad(v: number): string {
  return v.toFixed(2);
}
/** KV Cache 曲线轴刻度：复用卡头层的 tokens 紧凑格式化器，避免轴上出现
 *  "4200" 这种没有量级提示的裸数字，和大数字保持同一套换算规则 */
function formatTokensAxis(v: number): string {
  const c = formatTokensCompact(v);
  return `${c.value}${c.unit}`;
}
/** KV Cache 曲线 tooltip：同上复用紧凑格式化器 */
function formatTokensTooltip(v: number): string {
  const c = formatTokensCompact(v);
  return `${c.value} ${c.unit}`;
}

// 各卡的取行描述符：不依赖 props/state，提到模块作用域一次性建好——既喂给
// 本组件的 buildChartRows，也原样透传给放大弹层，弹层按自己选的 range 重新
// buildChartRows 时用的是同一份描述符，取行口径不会因为多写一份而漂移
const HOST_CPU_SPEC: ChartRowsSpec = { kind: "single", metric: METRIC_IDS.hostCpuPercent };
const HOST_MEM_SPEC: ChartRowsSpec = { kind: "single", metric: METRIC_IDS.hostMemUsedBytes };
const HOST_LOAD_SPEC: ChartRowsSpec = { kind: "single", metric: METRIC_IDS.hostLoad1 };
const HOST_DISK_IO_SPEC: ChartRowsSpec = {
  kind: "pair",
  metricA: METRIC_IDS.hostDiskReadBytesPerSec,
  metricB: METRIC_IDS.hostDiskWriteBytesPerSec,
};
const HOST_NET_SPEC: ChartRowsSpec = {
  kind: "pair",
  metricA: METRIC_IDS.hostNetRxBytesPerSec,
  metricB: METRIC_IDS.hostNetTxBytesPerSec,
};
const GPU_MEM_SPEC: ChartRowsSpec = { kind: "single", metric: METRIC_IDS.gpuMemUsedMib };
const GPU_UTIL_SPEC: ChartRowsSpec = { kind: "single", metric: METRIC_IDS.gpuUtilPercent };
const CONTAINER_CPU_SPEC: ChartRowsSpec = { kind: "single", metric: METRIC_IDS.containerCpuPercent };
const CONTAINER_MEM_SPEC: ChartRowsSpec = { kind: "single", metric: METRIC_IDS.containerMemBytes };
const INFER_TOKENS_SPEC: ChartRowsSpec = { kind: "single", metric: METRIC_IDS.inferTokensPerSec };
const INFER_KV_CACHE_SPEC: ChartRowsSpec = { kind: "single", metric: METRIC_IDS.inferKvCacheTokens };
const INFER_SLOTS_SPEC: ChartRowsSpec = { kind: "single", metric: METRIC_IDS.inferSlotsRunning };

// ---------- 主组件 ----------

export function OverviewCharts({
  initialGpuStatus,
  initialWindowPayload,
}: {
  initialGpuStatus: NvidiaStatus;
  /** 30m 档首帧 payload（任务 11 步骤 3）：由 (panel)/page.tsx 服务端直查
   *  store 传入，不经 HTTP，与 initialGpuStatus 同款做法——组件首帧直接
   *  拿它当已加载数据，不必等客户端第一次 fetch 回来才出图 */
  initialWindowPayload: WindowPayload;
}) {
  const t = useTranslations("pages.overview");
  const locale = useLocale();
  const { range, setRange, data, failed: windowFailed } = useOverviewWindow(initialWindowPayload);
  const { containerStats, gpuStatus, gpuSamples, gpuDevices, gpuTotals, hostStats, failed: statsFailed } =
    useOverviewStats(initialGpuStatus);
  const failed = windowFailed || statsFailed;
  const isLongRange = range === "24h" || range === "7d";

  // ---- 曲线数据（按描述符从 window payload 取行；data 为 null 时给空数组，
  // 各卡按 rows.length===0 独立判空态）----

  const gpuMemRows = data ? buildChartRows(data, GPU_MEM_SPEC) : [];
  const gpuUtilRows = data ? buildChartRows(data, GPU_UTIL_SPEC) : [];
  // 不能只看序列空否：store 有 SQLite 聚合桶，GPU 降级后历史点仍在，会显示一条停滞曲线
  const gpuHidden = gpuStatus !== "available" || (gpuMemRows.length === 0 && gpuUtilRows.length === 0);
  // 确认不可用（非探测中）才提示：探测中不出提示条，避免面板刚重启的窗口期
  // 误报"不可用"（沿用改造前 monitoring/metric-cards.tsx 的判据）
  const showGpuHint = gpuStatus === "unavailable";

  const containerCpuRows = data ? buildChartRows(data, CONTAINER_CPU_SPEC) : [];
  const containerMemRows = data ? buildChartRows(data, CONTAINER_MEM_SPEC) : [];

  const hostCpuRows = data ? buildChartRows(data, HOST_CPU_SPEC) : [];
  const hostMemRows = data ? buildChartRows(data, HOST_MEM_SPEC) : [];
  const hostLoadRows = data ? buildChartRows(data, HOST_LOAD_SPEC) : [];
  const hostDiskIoRows = data ? buildChartRows(data, HOST_DISK_IO_SPEC) : [];
  const hostNetRows = data ? buildChartRows(data, HOST_NET_SPEC) : [];

  const inferTokensRows = data ? buildChartRows(data, INFER_TOKENS_SPEC) : [];
  const inferKvCacheRows = data ? buildChartRows(data, INFER_KV_CACHE_SPEC) : [];
  const inferSlotsRows = data ? buildChartRows(data, INFER_SLOTS_SPEC) : [];
  // 推理组隐藏判据沿用改造前的"tokens 与 slots 两序列全空"，KV Cache 共用
  // 同一个判据（见文件头注释），不额外检查 inferKvCacheRows
  const inferHidden = inferTokensRows.length === 0 && inferSlotsRows.length === 0;

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

  // ---- 卡头当前值 + 分母副标（container/gpu/host 三路 stats 的最新样本，
  // 与曲线历史来源不同——见文件头注释）----

  const containerCpuSample = containerStats?.samples[METRIC_IDS.containerCpuPercent];
  const containerCpuMain: CardValue | null =
    containerCpuSample !== undefined ? cardFormatPercent(containerCpuSample.value) : null;
  const cpuCount = containerStats?.cpuCount ?? null;
  const containerCpuSubtitle = cpuCount !== null ? t("cardCpuSub", cpuCoresSub(cpuCount)) : undefined;

  const containerMemSample = containerStats?.samples[METRIC_IDS.containerMemBytes];
  const containerMemMain: CardValue | null =
    containerMemSample !== undefined ? cardFormatMib(containerMemSample.value / 1024 / 1024) : null;
  const containerMemPercentSample = containerStats?.samples[METRIC_IDS.containerMemPercent];
  const containerMemSubtitle =
    containerMemPercentSample !== undefined ? percentText(containerMemPercentSample.value) : undefined;

  const tokensSample = containerStats?.samples[METRIC_IDS.inferTokensPerSec];
  const tokensMain: CardValue | null =
    tokensSample !== undefined ? { value: tokensSample.value.toFixed(1), unit: "tok/s" } : null;

  const kvSample = containerStats?.samples[METRIC_IDS.inferKvCacheTokens];
  const kvMain: CardValue | null = kvSample !== undefined ? formatTokensCompact(kvSample.value) : null;

  const slotsSample = containerStats?.samples[METRIC_IDS.inferSlotsRunning];
  const slotsMain: CardValue | null =
    slotsSample !== undefined ? { value: String(Math.round(slotsSample.value)), unit: "" } : null;

  const hostCpuSample = hostStats?.samples[METRIC_IDS.hostCpuPercent];
  const hostCpuMain: CardValue | null = hostCpuSample !== undefined ? cardFormatPercent(hostCpuSample.value) : null;
  const hostCpuCount = hostStats?.hostCpuCount ?? null;
  // 容器卡与宿主机卡共用同一条 cardCpuSub 模板（"{count} 核 · 满载 {max}%"
  // 本就不含"容器"字样，语义对两者都成立，没必要另开一个冗余键）
  const hostCpuSubtitle = hostCpuCount !== null ? t("cardCpuSub", cpuCoresSub(hostCpuCount)) : undefined;

  const hostMemSample = hostStats?.samples[METRIC_IDS.hostMemUsedBytes];
  const hostMemMain: CardValue | null = hostMemSample !== undefined ? cardFormatMib(hostMemSample.value / 1024 / 1024) : null;
  const hostMemPercentSample = hostStats?.samples[METRIC_IDS.hostMemPercent];
  const hostMemTotal = hostStats?.hostMemTotalBytes ?? null;
  const hostMemSubtitle =
    hostMemPercentSample !== undefined && hostMemTotal !== null
      ? t("cardHostMemSub", { percent: percentText(hostMemPercentSample.value), total: formatSize(hostMemTotal) })
      : undefined;

  const hostLoadSample = hostStats?.samples[METRIC_IDS.hostLoad1];
  const hostLoadMain: CardValue | null =
    hostLoadSample !== undefined ? { value: formatLoad(hostLoadSample.value), unit: "" } : null;

  // 磁盘剩余（D2：不画曲线，只留卡头读数）
  const hostDiskFreeSample = hostStats?.samples[METRIC_IDS.hostDiskFreeBytes];
  const hostDiskFreeMain: CardValue | null =
    hostDiskFreeSample !== undefined ? cardFormatMib(hostDiskFreeSample.value / 1024 / 1024) : null;
  const hostDiskTotal = hostStats?.hostDiskTotalBytes ?? null;
  const hostDiskFreeSubtitle =
    hostDiskTotal !== null ? t("cardHostDiskSub", { total: formatSize(hostDiskTotal) }) : undefined;

  // 磁盘 IO / 网络收发：主数字取第一个指标（读 / 接收），副标带上第二个
  // 指标（写 / 发送）——二者总是成对出现，箭头符号不分语言，不必走 i18n
  // （沿用改造前 monitoring/metric-cards.tsx 的网络卡副标写法）
  const hostDiskReadSample = hostStats?.samples[METRIC_IDS.hostDiskReadBytesPerSec];
  const hostDiskWriteSample = hostStats?.samples[METRIC_IDS.hostDiskWriteBytesPerSec];
  const hostDiskIoMain: CardValue | null =
    hostDiskReadSample !== undefined ? cardBytesPerSec(hostDiskReadSample.value) : null;
  const hostDiskIoSubtitle =
    hostDiskWriteSample !== undefined
      ? (() => {
          const w = cardBytesPerSec(hostDiskWriteSample.value);
          return `↑ ${w.value} ${w.unit}`;
        })()
      : undefined;

  const hostNetRxSample = hostStats?.samples[METRIC_IDS.hostNetRxBytesPerSec];
  const hostNetTxSample = hostStats?.samples[METRIC_IDS.hostNetTxBytesPerSec];
  const hostNetMain: CardValue | null = hostNetRxSample !== undefined ? cardBytesPerSec(hostNetRxSample.value) : null;
  const hostNetSubtitle =
    hostNetTxSample !== undefined
      ? (() => {
          const tx = cardBytesPerSec(hostNetTxSample.value);
          return `↑ ${tx.value} ${tx.unit}`;
        })()
      : undefined;

  // GPU 显存：totals 缺失或 memTotalMib 为 0（老驱动查不到 total）时主数字
  // 退化为现状单值；副标三段——占用率（依赖 totals）+ 温度取 max（最热的卡
  // 是瓶颈）+ 功耗取 sum（供电视角），某段全卡都是 null 就不拼这段
  const gpuMemSample = gpuSamples?.[METRIC_IDS.gpuMemUsedMib];
  const gpuHasTotal = gpuTotals !== null && gpuTotals.memTotalMib > 0;
  const gpuMemMainValue: CardValue | null = gpuHasTotal
    ? gpuMemMain(gpuTotals.memUsedMib, gpuTotals.memTotalMib)
    : gpuMemSample !== undefined
      ? cardFormatMib(gpuMemSample.value)
      : null;
  const gpuMemSubtitleParts: string[] = [];
  if (gpuHasTotal) gpuMemSubtitleParts.push(gpuMemPercentText(gpuTotals.memUsedMib, gpuTotals.memTotalMib));
  const gpuTemps = gpuDevices.map((d) => d.tempC).filter((v): v is number => v !== null);
  const gpuMaxTemp = gpuMaxTempC(gpuTemps);
  if (gpuMaxTemp !== null) gpuMemSubtitleParts.push(`${gpuMaxTemp}°C`);
  const gpuPowers = gpuDevices.map((d) => d.powerW).filter((v): v is number => v !== null);
  const gpuTotalPower = gpuTotalPowerW(gpuPowers);
  if (gpuTotalPower !== null) gpuMemSubtitleParts.push(`${gpuTotalPower}W`);
  // 多卡聚合的口径必须点破：显存是各卡求和、温度取最高、功耗合计（这是
  // 拍板过的既定设计，不改成分卡展示），不说明的话多卡用户会把"12 / 48 GiB"
  // 读成某一张卡的数字。单卡不拼这段——没有歧义，多一句反而是噪音
  if (gpuDevices.length > 1) {
    gpuMemSubtitleParts.push(t("chartsGpuMultiHint", { count: gpuDevices.length }));
  }
  const gpuMemSubtitle = gpuMemSubtitleParts.length > 0 ? gpuMemSubtitleParts.join(" · ") : undefined;

  const gpuUtilSample = gpuSamples?.[METRIC_IDS.gpuUtilPercent];
  const gpuUtilMain: CardValue | null = gpuUtilSample !== undefined ? cardFormatPercent(gpuUtilSample.value) : null;

  return (
    <>
      {/* 时间范围 Tabs + 加载失败提示：固定不滚动（shrink-0）——下方图卡区
          独立滚动，滚到最后一张卡时还要能直接切时间范围，不用先滚回顶部 */}
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
        {/* 确认不可用（非探测中）：隐藏 GPU 两卡，提示条说明部署要求
            （从 monitoring/metric-cards.tsx 搬来，改造前的概览图表没有这条
            提示——GPU 降级时两卡直接消失、没有解释；合卡顺带补上） */}
        {showGpuHint && (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            {t("gpuHint")}
          </p>
        )}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {/* ---- 宿主机组（6 卡，恒渲染，各卡按自身序列独立判空态；磁盘剩余
              没有 chart 属性——D2 降级为只读数不画曲线） ---- */}
          <OverviewCard
            icon={Server}
            title={t("chartsHostCpuTitle")}
            main={hostCpuMain}
            subtitle={hostCpuSubtitle}
            chart={{
              rows: hostCpuRows,
              rowsSpec: HOST_CPU_SPEC,
              range,
              lines: [{ dataKey: "value", color: "var(--chart-1)", variant: "line", strokeWidth: 1.8 }],
              tooltipLines: [
                { key: "value", label: t("chartsCpu"), format: formatPercent, colorClass: "bg-chart-1" },
              ],
              timeFmt: tooltipTimeFmt,
              axisTimeFmt,
              yAxis: { unit: "%", width: 40 },
              isEmpty: hostCpuRows.length === 0,
              emptyLabel: t("chartsEmpty"),
            }}
          />
          <OverviewCard
            icon={MemoryStick}
            title={t("chartsHostMemTitle")}
            main={hostMemMain}
            subtitle={hostMemSubtitle}
            chart={{
              rows: hostMemRows,
              rowsSpec: HOST_MEM_SPEC,
              range,
              lines: [{ dataKey: "value", color: "var(--chart-5)", variant: "line", strokeWidth: 1.8 }],
              tooltipLines: [
                { key: "value", label: t("chartsMem"), format: formatSize, colorClass: "bg-chart-5" },
              ],
              timeFmt: tooltipTimeFmt,
              axisTimeFmt,
              yAxis: { tickFormatter: formatBytesAxis, width: 44 },
              isEmpty: hostMemRows.length === 0,
              emptyLabel: t("chartsEmpty"),
            }}
          />
          <OverviewCard
            icon={Server}
            title={t("chartsHostLoadTitle")}
            main={hostLoadMain}
            chart={{
              rows: hostLoadRows,
              rowsSpec: HOST_LOAD_SPEC,
              range,
              lines: [{ dataKey: "value", color: "var(--chart-3)", variant: "line", strokeWidth: 1.8 }],
              tooltipLines: [
                { key: "value", label: t("chartsHostLoadTitle"), format: formatLoad, colorClass: "bg-chart-3" },
              ],
              timeFmt: tooltipTimeFmt,
              axisTimeFmt,
              yAxis: { tickFormatter: formatLoad, width: 34 },
              isEmpty: hostLoadRows.length === 0,
              emptyLabel: t("chartsEmpty"),
            }}
          />
          <OverviewCard
            icon={HardDrive}
            title={t("chartsHostDiskTitle")}
            main={hostDiskFreeMain}
            subtitle={hostDiskFreeSubtitle}
          />
          <OverviewCard
            icon={HardDrive}
            title={t("chartsHostDiskIoTitle")}
            main={hostDiskIoMain}
            subtitle={hostDiskIoSubtitle}
            chart={{
              rows: hostDiskIoRows,
              rowsSpec: HOST_DISK_IO_SPEC,
              range,
              lines: [
                { dataKey: "a", color: "var(--chart-2)", variant: "line", strokeWidth: 1.8 },
                { dataKey: "b", color: "var(--chart-4)", variant: "line", strokeWidth: 1.8 },
              ],
              tooltipLines: [
                { key: "a", label: t("chartsHostDiskIoRead"), format: formatBytesPerSec, colorClass: "bg-chart-2" },
                { key: "b", label: t("chartsHostDiskIoWrite"), format: formatBytesPerSec, colorClass: "bg-chart-4" },
              ],
              timeFmt: tooltipTimeFmt,
              axisTimeFmt,
              yAxis: { tickFormatter: formatBytesAxisPerSec, width: 52 },
              isEmpty: hostDiskIoRows.length === 0,
              emptyLabel: t("chartsEmpty"),
            }}
          />
          <OverviewCard
            icon={Network}
            title={t("chartsHostNetTitle")}
            main={hostNetMain}
            subtitle={hostNetSubtitle}
            chart={{
              rows: hostNetRows,
              rowsSpec: HOST_NET_SPEC,
              range,
              lines: [
                { dataKey: "a", color: "var(--chart-1)", variant: "line", strokeWidth: 1.8 },
                { dataKey: "b", color: "var(--chart-5)", variant: "line", strokeWidth: 1.8 },
              ],
              tooltipLines: [
                { key: "a", label: t("chartsHostNetRx"), format: formatBytesPerSec, colorClass: "bg-chart-1" },
                { key: "b", label: t("chartsHostNetTx"), format: formatBytesPerSec, colorClass: "bg-chart-5" },
              ],
              timeFmt: tooltipTimeFmt,
              axisTimeFmt,
              yAxis: { tickFormatter: formatBytesAxisPerSec, width: 52 },
              isEmpty: hostNetRows.length === 0,
              emptyLabel: t("chartsEmpty"),
            }}
          />

          {/* ---- GPU 组（2 卡，共用 gpuHidden：同源于一次 nvidia-smi 探测）---- */}
          <OverviewCard
            icon={Zap}
            title={t("chartsGpuMemTitle")}
            main={gpuMemMainValue}
            subtitle={gpuMemSubtitle}
            hidden={gpuHidden}
            chart={{
              rows: gpuMemRows,
              rowsSpec: GPU_MEM_SPEC,
              range,
              lines: [
                { dataKey: "value", color: "var(--chart-1)", variant: "area", gradientId: "gpuMemFill", strokeWidth: 2 },
              ],
              tooltipLines: [
                {
                  key: "value",
                  label: t("chartsGpuMem"),
                  format: (v) => formatSize(v * 1024 * 1024),
                  colorClass: "bg-chart-1",
                },
              ],
              timeFmt: tooltipTimeFmt,
              axisTimeFmt,
              yAxis: { tickFormatter: formatMibAxis, width: 44 },
              isEmpty: false,
              emptyLabel: t("chartsEmpty"),
            }}
          />
          <OverviewCard
            icon={Gauge}
            title={t("chartsGpuUtilTitle")}
            main={gpuUtilMain}
            hidden={gpuHidden}
            chart={{
              rows: gpuUtilRows,
              rowsSpec: GPU_UTIL_SPEC,
              range,
              lines: [
                { dataKey: "value", color: "var(--chart-5)", variant: "line", strokeWidth: 1.5, strokeDasharray: "5 4" },
              ],
              tooltipLines: [
                { key: "value", label: t("chartsGpuUtil"), format: formatPercent, colorClass: "bg-chart-5" },
              ],
              timeFmt: tooltipTimeFmt,
              axisTimeFmt,
              yAxis: { domain: [0, 100], unit: "%", width: 34 },
              isEmpty: false,
              emptyLabel: t("chartsEmpty"),
            }}
          />

          {/* ---- 模型容器组（2 卡，恒渲染，各卡按自身序列独立判空态）---- */}
          <OverviewCard
            icon={Cpu}
            title={t("chartsContainerCpuTitle")}
            main={containerCpuMain}
            subtitle={containerCpuSubtitle}
            chart={{
              rows: containerCpuRows,
              rowsSpec: CONTAINER_CPU_SPEC,
              range,
              lines: [{ dataKey: "value", color: "var(--chart-1)", variant: "line", strokeWidth: 1.8 }],
              tooltipLines: [
                { key: "value", label: t("chartsCpu"), format: formatPercent, colorClass: "bg-chart-1" },
              ],
              timeFmt: tooltipTimeFmt,
              axisTimeFmt,
              yAxis: { unit: "%", width: 40 },
              isEmpty: containerCpuRows.length === 0,
              emptyLabel: t("chartsEmpty"),
            }}
          />
          <OverviewCard
            icon={MemoryStick}
            title={t("chartsContainerMemTitle")}
            main={containerMemMain}
            subtitle={containerMemSubtitle}
            chart={{
              rows: containerMemRows,
              rowsSpec: CONTAINER_MEM_SPEC,
              range,
              lines: [{ dataKey: "value", color: "var(--chart-5)", variant: "line", strokeWidth: 1.8 }],
              tooltipLines: [
                { key: "value", label: t("chartsMem"), format: formatSize, colorClass: "bg-chart-5" },
              ],
              timeFmt: tooltipTimeFmt,
              axisTimeFmt,
              yAxis: { tickFormatter: formatBytesAxis, width: 44 },
              isEmpty: containerMemRows.length === 0,
              emptyLabel: t("chartsEmpty"),
            }}
          />

          {/* ---- 推理组（3 卡，共用 inferHidden：同源于一次 /health+/slots
              探测；KV Cache 是这次合卡新补的卡，指标早就在采，只是改造前
              的 overview-charts 没画）---- */}
          <OverviewCard
            icon={Activity}
            title={t("chartsInferTokensTitle")}
            main={tokensMain}
            hidden={inferHidden}
            chart={{
              rows: inferTokensRows,
              rowsSpec: INFER_TOKENS_SPEC,
              range,
              lines: [
                { dataKey: "value", color: "var(--chart-2)", variant: "area", gradientId: "inferTokensFill", strokeWidth: 1.8 },
              ],
              tooltipLines: [
                {
                  key: "value",
                  label: t("chartsInferTokens"),
                  format: (v) => v.toFixed(1),
                  colorClass: "bg-chart-2",
                },
              ],
              timeFmt: tooltipTimeFmt,
              axisTimeFmt,
              yAxis: { width: 40 },
              isEmpty: false,
              emptyLabel: t("chartsEmpty"),
            }}
          />
          <OverviewCard
            icon={Database}
            title={t("chartsInferKvCacheTitle")}
            main={kvMain}
            hidden={inferHidden}
            chart={{
              rows: inferKvCacheRows,
              rowsSpec: INFER_KV_CACHE_SPEC,
              range,
              lines: [{ dataKey: "value", color: "var(--chart-3)", variant: "line", strokeWidth: 1.8 }],
              tooltipLines: [
                {
                  key: "value",
                  label: t("chartsInferKvCacheTitle"),
                  format: formatTokensTooltip,
                  colorClass: "bg-chart-3",
                },
              ],
              timeFmt: tooltipTimeFmt,
              axisTimeFmt,
              yAxis: { tickFormatter: formatTokensAxis, width: 40 },
              isEmpty: false,
              emptyLabel: t("chartsEmpty"),
            }}
          />
          <OverviewCard
            icon={Layers}
            title={t("chartsInferSlotsTitle")}
            main={slotsMain}
            hidden={inferHidden}
            chart={{
              rows: inferSlotsRows,
              rowsSpec: INFER_SLOTS_SPEC,
              range,
              lines: [{ dataKey: "value", color: "var(--chart-4)", variant: "line", type: "stepAfter", strokeWidth: 1.5 }],
              tooltipLines: [
                {
                  key: "value",
                  label: t("chartsSlots"),
                  format: (v) => String(Math.round(v)),
                  colorClass: "bg-chart-4",
                },
              ],
              timeFmt: tooltipTimeFmt,
              axisTimeFmt,
              yAxis: { allowDecimals: false, width: 26 },
              isEmpty: false,
              emptyLabel: t("chartsEmpty"),
            }}
          />
        </div>

        <p className="text-[11px] text-muted-foreground">{t("chartsFootnote")}</p>
      </div>
    </>
  );
}
