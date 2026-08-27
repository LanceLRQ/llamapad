"use client";

import { Timer } from "lucide-react";
import { useTranslations } from "next-intl";

import { ParamTip } from "@/components/param-tip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  REFRESH_INTERVAL_OPTIONS,
  type RefreshIntervalMs,
} from "@/lib/refresh-interval";
import { useRefreshInterval } from "@/lib/use-refresh-interval";

/** 档位展示文案：五档均为整秒值，除以 1000 拼 "s" 即可（1000 → "1s"） */
function formatIntervalLabel(ms: RefreshIntervalMs): string {
  return `${ms / 1000}s`;
}

/**
 * 刷新间隔选择器（用户反馈"监控指标刷新慢"）：监控页指标卡与概览页图表
 * 共用同一个组件，状态经 useRefreshInterval 的模块级 store 联动——两页
 * 各自独立挂载，互不知晓对方存在也能保持一致的选择结果。
 *
 * 旁边的 ParamTip 讲的是「24h/7d 图表不受此设置影响」——那两档背后是分钟级
 * 聚合桶，秒级轮询读不到新点，恒 60s。这是用户改了间隔却发现某些图没变快时
 * 唯一会困惑的地方，值得占一个提示位。
 */
export function RefreshIntervalSelect() {
  const t = useTranslations("common");
  const { intervalMs, setIntervalMs } = useRefreshInterval();

  return (
    <div className="flex items-center gap-1">
      <Select
        value={intervalMs}
        onValueChange={(value) => {
          if (value !== null) setIntervalMs(value);
        }}
      >
        <SelectTrigger size="sm" aria-label={t("refreshIntervalLabel")} className="gap-1 font-mono text-xs">
          <Timer className="size-3.5 text-muted-foreground" />
          <SelectValue>
            {(value: RefreshIntervalMs | null) =>
              value !== null ? formatIntervalLabel(value) : ""
            }
          </SelectValue>
        </SelectTrigger>
        <SelectContent align="end">
          {REFRESH_INTERVAL_OPTIONS.map((ms) => (
            <SelectItem key={ms} value={ms} className="font-mono text-xs">
              {formatIntervalLabel(ms)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <ParamTip text={t("refreshIntervalHint")} />
    </div>
  );
}
