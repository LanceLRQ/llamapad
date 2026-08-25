import { getTranslations } from "next-intl/server";

import { LogTerminal } from "@/components/terminal";
import { Card } from "@/components/ui/card";
import { getMetricsCollector } from "@/server/locators";
import { MonitoringMetricCards } from "./metric-cards";

// 惰性采集单例（首次取用开跑心跳）→ 全动态渲染
export const dynamic = "force-dynamic";

/**
 * 监控页（M3 Task 5）：上区指标卡网格（client 组件轮询当前值 + sparkline，
 * GPU 不可用时隐藏两卡并出提示条），下区全宽终端日志卡（60vh 可滚动，
 * SSE 实时流，恒深色设计约定见 terminal.tsx 文件头）。
 */
export default async function MonitoringPage() {
  const t = await getTranslations("pages.monitoring");

  // 打开监控页即确保指标采集心跳在跑（幂等单例）；probe 结果直传 SSR 首帧
  getMetricsCollector();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h1 className="text-base font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <MonitoringMetricCards
        initialGpuStatus={getMetricsCollector().nvidiaStatus()}
      />

      {/* 全宽终端卡：滚动体高度 60vh（终端组件自带工具条与三按钮） */}
      <Card size="sm" className="gap-0 py-0">
        <LogTerminal streamUrl="/api/v1/logs/stream" bodyClassName="h-[60vh]" />
      </Card>
    </div>
  );
}
