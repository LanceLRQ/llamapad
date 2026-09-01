"use client";

import { useState } from "react";
import { Maximize2, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";

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
 * 历史可放大）。
 */
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

export interface OverviewCardProps {
  icon: LucideIcon;
  title: string;
  /** 卡头大数字；null 时显示 "—"（未采到样本，与 metric-cards.tsx 的既有
   *  "—" 兜底一致） */
  main: CardValue | null;
  /** 大数字下方、曲线上方的分母副标；undefined 时整行不渲染（不留空占位） */
  subtitle?: string;
  chart?: OverviewChartProps;
  /** 按 gpuStatus / 两序列皆空判定的整组隐藏（GPU、推理两组用）；
   *  true 时整卡不渲染 */
  hidden?: boolean;
}

export function OverviewCard({ icon: Icon, title, main, subtitle, chart, hidden }: OverviewCardProps) {
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
      <CardContent>
        <div className="flex items-start justify-between gap-3">
          <span className="flex items-center gap-1.5 text-xs font-semibold">
            <Icon className="size-3.5 text-muted-foreground" />
            {title}
          </span>
          {/* 空态 / 无曲线卡没有数据可放大，不渲染入口 */}
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

        <div className="mt-1 flex items-baseline gap-1.5">
          <span className="font-mono text-xl leading-tight font-bold tabular-nums">
            {main?.value ?? "—"}
          </span>
          {main !== null && main.unit !== "" && (
            <span className="text-xs text-muted-foreground">{main.unit}</span>
          )}
        </div>
        {subtitle !== undefined && (
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
