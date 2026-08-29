"use client";

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

import type { ChartRow, SeriesKey } from "@/lib/chart-format";

/**
 * 单轴图表的展示层（从 overview-charts.tsx 拆出）：卡内小图与放大弹层的
 * 大图共用同一份画法，避免两处画法漂移。本组件不决定高度——只渲染
 * <ResponsiveContainer width="100%" height="100%">，由调用方给外层盒子
 * 定高（卡内 h-40，弹层内大高度）。
 */

// 轴/网格公共样式（SVG 属性直接吃 CSS 变量，随主题自动切换）；与组件状态
// 无关的纯样式对象，提到模块作用域，多张卡共用同一份不必逐卡重建
const AXIS_TICK = { fontSize: 11, fill: "var(--muted-foreground)" };
const GRID_STROKE = "var(--border)";
const CHART_MARGIN = { top: 6, right: 2, bottom: 0, left: 0 };

// ---------- 图例小件 ----------

export function LegendItem({
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

// ---------- tooltip ----------

/** tooltip 行配置：dataKey → 双语标签 + 值格式化 + 圆点色 */
export interface TooltipLine {
  key: SeriesKey;
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

// ---------- 图表主体 ----------

/** 单条曲线的绘制方式：Area 用于"总量/累积"型语义（GPU 显存、推理 tok/s
 *  的前身设计如此，拆卡后原样保留哪条线用 Area），其余走 Line */
export interface SeriesLine {
  dataKey: SeriesKey;
  color: string;
  variant: "line" | "area";
  type?: "monotone" | "stepAfter";
  strokeWidth?: number;
  strokeDasharray?: string;
  /** variant 为 area 时必填：<defs> 里渐变的 id */
  gradientId?: string;
}

/** Y 轴配置：卡内小图与放大弹层共用，避免同一份形状在三处各写一遍字面量类型 */
export interface YAxisConfig {
  tickFormatter?: (v: number) => string;
  unit?: string;
  domain?: [number, number];
  width: number;
  allowDecimals?: boolean;
}

export function SeriesChart({
  rows,
  lines,
  tooltipLines,
  timeFmt,
  axisTimeFmt,
  yAxis,
}: {
  rows: ChartRow[];
  lines: SeriesLine[];
  tooltipLines: TooltipLine[];
  timeFmt: Intl.DateTimeFormat;
  axisTimeFmt: Intl.DateTimeFormat;
  yAxis: YAxisConfig;
}) {
  const areaLines = lines.filter((line) => line.variant === "area");
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={rows} margin={CHART_MARGIN}>
        {areaLines.length > 0 && (
          <defs>
            {areaLines.map((line) => (
              <linearGradient key={line.gradientId} id={line.gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={line.color} stopOpacity={0.25} />
                <stop offset="100%" stopColor={line.color} stopOpacity={0.04} />
              </linearGradient>
            ))}
          </defs>
        )}
        <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 5" vertical={false} />
        <XAxis
          dataKey="ts"
          type="number"
          scale="time"
          domain={["dataMin", "dataMax"]}
          tickFormatter={(ts: number) => axisTimeFmt.format(ts)}
          tick={AXIS_TICK}
          axisLine={{ stroke: GRID_STROKE }}
          tickLine={false}
          minTickGap={32}
        />
        <YAxis
          tickFormatter={yAxis.tickFormatter}
          unit={yAxis.unit}
          domain={yAxis.domain}
          allowDecimals={yAxis.allowDecimals}
          width={yAxis.width}
          tick={AXIS_TICK}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip
          cursor={{ stroke: GRID_STROKE, strokeDasharray: "3 3" }}
          content={<ChartTooltip timeFmt={timeFmt} lines={tooltipLines} />}
        />
        {lines.map((line) =>
          line.variant === "area" ? (
            <Area
              key={line.dataKey}
              dataKey={line.dataKey}
              type={line.type ?? "monotone"}
              stroke={line.color}
              strokeWidth={line.strokeWidth ?? 2}
              fill={`url(#${line.gradientId})`}
              connectNulls
              dot={false}
              isAnimationActive={false}
            />
          ) : (
            <Line
              key={line.dataKey}
              dataKey={line.dataKey}
              type={line.type ?? "monotone"}
              stroke={line.color}
              strokeWidth={line.strokeWidth ?? 1.8}
              strokeDasharray={line.strokeDasharray}
              connectNulls
              dot={false}
              isAnimationActive={false}
            />
          ),
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
