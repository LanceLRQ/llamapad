"use client";

import { useState } from "react";
import { Maximize2, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SeriesChart, type SeriesLine, type TooltipLine, type YAxisConfig } from "@/components/series-chart";
import { type ChartRow, type ChartRowsSpec } from "@/lib/chart-format";
import { type CardValue } from "@/lib/metric-card-value";
import { type RangeKey } from "@/server/metrics/window";
import { ChartDialog } from "./chart-dialog";

/**
 * 概览合卡的卡片渲染（任务 13 从 overview-charts.tsx 的 SeriesChartCard 与
 * monitoring/metric-cards.tsx 的 MetricCard 合并提出）：卡头 = 图标 + 标题 +
 * 当前值大数字 + 分母副标，下接历史曲线（跟随页面 range 档位）+ 放大入口。
 *
 * chart 为 undefined 时是"只读数、不画图"的特例（目前仅宿主机磁盘剩余卡，
 * D2：变化太慢，折线看不出东西）——不渲染曲线区，也不渲染放大入口（没有
 * 历史可放大）。磁盘剩余卡改用 donut（环形图）填补这块空白：语义是"当前值
 * 快照"而非跟随 range 档位的历史趋势，与 chart 是两码事，两个 prop 互斥
 * （调用处只有磁盘卡会传 donut，其余卡都传 chart 或都不传）。
 */

// 环形图两段固定配色：已用取主题强调色（--chart-1，与其余卡曲线常用的
// 强调色同源），剩余取次要文字灰（--muted-foreground）——在浅色/深色卡片
// 背景下都有足够对比度，且和"次要信息"的既有配色语义一致；都走 CSS 变量，
// 不硬编码十六进制，随主题自动切换
const DISK_DONUT_USED_COLOR = "var(--chart-1)";
const DISK_DONUT_FREE_COLOR = "var(--muted-foreground)";

interface OverviewChartProps {
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
  /** 按本卡自身序列判定的空态（宿主机、容器各卡独立判断）；true 时曲线区
   *  换成空态文案，且不渲染放大入口（空态没有数据可放大） */
  isEmpty: boolean;
  emptyLabel: string;
}

/** 磁盘剩余卡的环形图数据：已用/剩余两段字节数（分段与使用率下沉到
 *  lib/disk-donut.ts 计算，本组件不重算），字节数只用于两段的相对比例，
 *  百分比文案单独传入而不是组件里用 used/total 现算，避免和 lib 层的取整
 *  规则不一致漂移出两套百分比 */
export interface OverviewDonutProps {
  usedBytes: number;
  freeBytes: number;
  /** 中心文案：使用率（已下沉到 lib 计算 + 取整） */
  percentUsed: number;
  usedLabel: string;
  freeLabel: string;
}

export interface OverviewCardProps {
  icon: LucideIcon;
  title: string;
  /** 卡头大数字；null 时显示 "—"（未采到样本，与 metric-cards.tsx 的既有
   *  "—" 兜底一致） */
  main: CardValue | null;
  /** 大数字下方、曲线上方的分母副标；undefined 时整行不渲染（不留空占位） */
  subtitle?: string;
  chart?: OverviewChartProps;
  /** 磁盘剩余卡专用的环形图快照；undefined 时不渲染（含"数据缺失"——由
   *  调用方按 computeDiskDonut 返回 null 决定是否传入，本组件不重复判空） */
  donut?: OverviewDonutProps;
  /** 按 gpuStatus / 两序列皆空判定的整组隐藏（GPU、推理两组用）；
   *  true 时整卡不渲染 */
  hidden?: boolean;
}

export function OverviewCard({ icon: Icon, title, main, subtitle, chart, donut, hidden }: OverviewCardProps) {
  const t = useTranslations("pages.overview");
  const [dialogOpen, setDialogOpen] = useState(false);
  // 首次点击才挂载弹层（13 张卡没人点就没有 13 份弹层状态），挂载后不再卸载，
  // 只靠 open 切换——Dialog 的关闭动画需要 DOM 在 data-closed 期间还留着，
  // 卸载会让动画来不及播完
  const [dialogMounted, setDialogMounted] = useState(false);
  // 弹层自己的 range，只在"点击放大"这一刻从页面当前 range 播种——弹层常驻
  // 挂载意味着这份 state 不会随页面切档自动更新，必须在每次打开时显式重播，
  // 否则重开同一张卡会停在上次在弹层里选的档位而不是页面当前档位
  const [dialogRange, setDialogRange] = useState<RangeKey>(chart?.range ?? "30m");
  if (hidden) return null;

  return (
    <Card>
      {/* donut 卡跳过了大数字行与副标行（读数并进了卡头），比其余卡少两行；
          栅格 stretch 把卡片拉到行内等高后，多出来的空间会全堆在底部，环形组
          看起来贴着上边。改成撑满的 flex 列，让下面的环形区用 flex-1 吃掉剩余
          空间并在其中垂直居中。其余 12 张卡不传 donut，className 为 undefined，
          渲染与改造前逐字相同 */}
      <CardContent className={donut ? "flex flex-1 flex-col" : undefined}>
        <div className={`flex justify-between gap-3 ${donut ? "items-center" : "items-start"}`}>
          <span className="flex items-center gap-1.5 text-xs font-semibold">
            <Icon className="size-3.5 text-muted-foreground" />
            {title}
          </span>
          {/* donut 卡（目前仅磁盘剩余）把读数并进卡头右侧，对齐首页磁盘卡的
              排布（page.tsx「磁盘卡」：标题左 + 读数右，font-mono text-xs
              tabular-nums 单行呈现，不做大数字/小单位的两级字号），不再走
              下方的大数字行——真人反馈：卡名与大数字都在标题正下方时读数
              离标题太远，改到同一行对齐首页那张磁盘卡的既有样式。这个分支
              只吃 donut，其余 12 张卡不传 donut，恒不渲染，不影响它们 */}
          {donut && (
            <span className="shrink-0 whitespace-nowrap font-mono text-xs tabular-nums">
              {main?.value ?? "—"}
              {main !== null && main.unit !== "" ? ` ${main.unit}` : ""}
            </span>
          )}
          {/* 空态 / 无曲线卡没有数据可放大，不渲染入口（这块与改造前逐字
              相同——donut 卡不传 chart，恒不进这个分支，不受上面新增分支
              影响） */}
          {chart && !chart.isEmpty && (
            <Button
              variant="ghost"
              size="icon-sm"
              title={t("chartsExpand")}
              onClick={() => {
                setDialogRange(chart.range);
                setDialogMounted(true);
                setDialogOpen(true);
              }}
            >
              <Maximize2 />
              <span className="sr-only">{t("chartsExpand")}</span>
            </Button>
          )}
        </div>

        {/* donut 卡的读数已经并进卡头（见上），下面这个大数字行 + 副标行整个
            跳过，避免同一个数字出现两次；其余 12 张卡 donut 恒为 undefined，
            !donut 恒真，这两块渲染与改造前逐字相同 */}
        {!donut && (
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="font-mono text-xl leading-tight font-bold tabular-nums">
              {main?.value ?? "—"}
            </span>
            {main !== null && main.unit !== "" && (
              <span className="text-xs text-muted-foreground">{main.unit}</span>
            )}
          </div>
        )}
        {!donut && subtitle !== undefined && (
          <div className="mt-0.5 text-xs text-muted-foreground">{subtitle}</div>
        )}

        {chart &&
          (chart.isEmpty ? (
            <div className="mt-2 flex h-36 items-center justify-center text-xs text-muted-foreground">
              {chart.emptyLabel}
            </div>
          ) : (
            <div className="mt-2 h-36">
              <SeriesChart
                rows={chart.rows}
                lines={chart.lines}
                tooltipLines={chart.tooltipLines}
                timeFmt={chart.timeFmt}
                axisTimeFmt={chart.axisTimeFmt}
                yAxis={chart.yAxis}
              />
            </div>
          ))}

        {/* 磁盘剩余卡的环形图：min-h-36 保底（与其余卡曲线区同高），flex-1
            吃掉卡片剩余空间，使环形组在卡片里垂直居中而不是贴着上边；
            donut 为 undefined 时（数据缺失，见 computeDiskDonut）不
            渲染任何占位——沿用改造前"没有 chart 时就是空白"的既有空态逻辑，
            不为此单独发明一套空态文案 */}
        {donut && (
          // justify-center：真人反馈「图可以居中」——环形图 + 右侧图例作为
          // 一组整体在卡片里水平居中，图例本身仍贴着环形右侧不单独处理
          <div className="mt-2 flex min-h-36 flex-1 items-center justify-center gap-4">
            <div className="relative size-28 shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={[
                      { key: "used", value: donut.usedBytes },
                      { key: "free", value: donut.freeBytes },
                    ]}
                    dataKey="value"
                    nameKey="key"
                    cx="50%"
                    cy="50%"
                    innerRadius="68%"
                    outerRadius="100%"
                    startAngle={90}
                    endAngle={-270}
                    stroke="var(--card)"
                    strokeWidth={2}
                    isAnimationActive={false}
                  >
                    <Cell fill={DISK_DONUT_USED_COLOR} />
                    <Cell fill={DISK_DONUT_FREE_COLOR} />
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              {/* 中心使用率文案：recharts 的 Pie 没有内置中心文本，用绝对
                  定位盖一层——pointer-events-none 避免挡住下层的 hover */}
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center leading-none">
                <span className="font-mono text-sm font-semibold tabular-nums">{donut.percentUsed}%</span>
                {/* 必须带标签：卡名是「磁盘剩余」、大数字也是剩余量，环心这个百分比却是
                    「已用」占比——不标注的话读者会顺着卡名把它读成「剩余 67%」，正好反了 */}
                <span className="mt-1 text-[10px] text-muted-foreground">{donut.usedLabel}</span>
              </div>
            </div>
            <ul className="flex flex-col gap-1.5 text-xs text-muted-foreground">
              <li className="flex items-center gap-1.5">
                <span aria-hidden className="inline-block size-1.5 rounded-full bg-chart-1" />
                {donut.usedLabel}
              </li>
              <li className="flex items-center gap-1.5">
                <span aria-hidden className="inline-block size-1.5 rounded-full bg-muted-foreground" />
                {donut.freeLabel}
              </li>
            </ul>
          </div>
        )}
      </CardContent>
      {chart && dialogMounted && (
        <ChartDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          title={title}
          icon={Icon}
          range={dialogRange}
          onRangeChange={setDialogRange}
          rowsSpec={chart.rowsSpec}
          lines={chart.lines}
          tooltipLines={chart.tooltipLines}
          yAxis={chart.yAxis}
        />
      )}
    </Card>
  );
}
