"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SeriesChart, type SeriesLine, type TooltipLine, type YAxisConfig } from "@/components/series-chart";
import { buildChartRows, type ChartRowsSpec } from "@/lib/chart-format";
import { apiFetch } from "@/lib/api";
import { useRefreshInterval } from "@/lib/use-refresh-interval";
import { RANGE_KEYS, type RangeKey, type WindowPayload } from "@/server/metrics/window";

function isRangeKey(value: unknown): value is RangeKey {
  return typeof value === "string" && (RANGE_KEYS as readonly string[]).includes(value);
}

/**
 * 图卡放大弹层：大尺寸重画同一张图，自带时间范围 Tabs 并独立取数——弹层内
 * 切换范围只影响弹层自己，绝不回写页面选中的 range（用户在页面另一档位下
 * 打开弹层细看历史，不该被"顺手一切"打断页面正在看的实时窗口）。
 *
 * range 由调用方（SeriesChartCard）受控：本组件常驻挂载（关闭动画需要
 * DOM 留着），若自己攥一份 range state 就只在首次挂载时播种一次，重开
 * 同一张卡会停在上次在弹层里选的档位而不是页面当前档位——调用方在每次
 * "点击放大"时显式重播 range，这里只负责展示与上抛变更。
 *
 * 取数节拍照抄 overview-charts.tsx 的既有 effect：24h/7d 恒 60s，其余跟随
 * useRefreshInterval() 的间隔；页面不可见时跳过，回到可见立即补拉；
 * AbortController 负责切窗竞态与卸载清理。只在 open 为真时跑，关闭后
 * 效果不再挂计时器——不能让关掉的弹层继续占着轮询。
 */
export function ChartDialog({
  open,
  onOpenChange,
  title,
  icon: Icon,
  range,
  onRangeChange,
  rowsSpec,
  lines,
  tooltipLines,
  yAxis,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  icon: LucideIcon;
  range: RangeKey;
  onRangeChange: (range: RangeKey) => void;
  rowsSpec: ChartRowsSpec;
  lines: SeriesLine[];
  tooltipLines: TooltipLine[];
  yAxis: YAxisConfig;
}) {
  const t = useTranslations("pages.overview");
  const locale = useLocale();
  const { intervalMs } = useRefreshInterval();
  // null = 尚未拿到当前档位的数据（首次打开 / 刚切档位）：不渲染，避免闪一下
  // "无运行数据"又变图（同 run-history.tsx 的 runs === null 处理）；
  // loaded.range 与 range 不一致视为同一回事——切档瞬间旧数据立刻失效
  const [loaded, setLoaded] = useState<{ range: RangeKey; payload: WindowPayload } | null>(null);
  const [failed, setFailed] = useState(false);
  const data = loaded !== null && loaded.range === range ? loaded.payload : null;
  const isLongRange = range === "24h" || range === "7d";

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
    },
    [range],
  );

  useEffect(() => {
    if (!open) return; // 关闭即停：不给关掉的弹层继续挂计时器
    const controller = new AbortController();
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
  }, [open, load, range, intervalMs]);

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

  const rows = data ? buildChartRows(data, rowsSpec) : [];

  // 弹层与卡内小图同时在文档里（弹层挂载后不卸载），渐变 id 必须错开——
  // url(#id) 是文档级解析，撞 id 时取第一个命中的定义，当前两处渐变样式
  // 完全相同所以看不出差异，但仍是无效 HTML，样式一旦分化就会变成真 bug
  const dialogLines = useMemo(
    () => lines.map((line) => (line.gradientId ? { ...line, gradientId: `${line.gradientId}-dialog` } : line)),
    [lines],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[min(1100px,92vw)]">
        <DialogHeader>
          {/* pr-9 给右上角那个绝对定位的关闭按钮（top-2 right-2 + icon-sm 28px）
              让位，否则范围 Tabs 会被 ✕ 压住，最右的 7d 点不到 */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pr-9">
            <DialogTitle className="flex items-center gap-1.5">
              <Icon className="size-4 text-muted-foreground" />
              {title}
            </DialogTitle>
            <div className="flex-1" />
            <Tabs
              value={range}
              onValueChange={(value) => {
                if (isRangeKey(value)) onRangeChange(value);
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
          {failed && <p className="text-xs text-destructive">{t("chartsLoadError")}</p>}
        </DialogHeader>

        <div className="h-[min(58vh,540px)]">
          {data === null ? (
            // 尚未拿到当前档位的数据：渲染等高空白盒，不出空态文案——否则
            // 打开弹层或切档位的头一瞬间会先闪一下"无运行数据"再变成图
            <div className="h-full" />
          ) : rows.length === 0 ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              {t("chartsEmpty")}
            </div>
          ) : (
            <SeriesChart
              rows={rows}
              lines={dialogLines}
              tooltipLines={tooltipLines}
              timeFmt={tooltipTimeFmt}
              axisTimeFmt={axisTimeFmt}
              yAxis={yAxis}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
