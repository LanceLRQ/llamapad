import { Activity } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { PageHeader } from "@/components/shell/page-header";
import { LogTerminal } from "@/components/terminal";
import { Card } from "@/components/ui/card";
import { getMetricsCollector } from "@/server/locators";
import { MonitoringMetricCards } from "./metric-cards";
import { RunHistory } from "./run-history";

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
    // PageHeader 自带 border-b + px-7：内边距的控制权要交给页面自己，才能让这条
    // border-b 与其它套了同款外壳的页面一样通栏（与有没有二级栏无关）。T1 给 main
    // 留了 px-[34px] pt-7 pb-12，这里用负边距抵消，内容区再用 px-7 py-6 接回来。
    // 这是 T1→T11 迁移期的过渡做法，之后各页统一处理，届时这段注释与负边距一起删。
    <div className="-mx-[34px] -mt-7 -mb-12 flex min-h-full flex-col">
      <PageHeader icon={Activity} title={t("title")} subtitle={t("description")} />

      <div className="flex flex-col gap-4 px-7 py-6">
        <MonitoringMetricCards
          initialGpuStatus={getMetricsCollector().nvidiaStatus()}
        />

        {/* 运行历史（U17）：模型启停记录沉淀，空历史整块不渲染，见 run-history.tsx 头注释 */}
        <RunHistory />

        {/* 全宽终端卡：滚动体高度 60vh（终端组件自带工具条与三按钮） */}
        <Card size="sm" className="gap-0 py-0">
          <LogTerminal streamUrl="/api/v1/logs/stream" bodyClassName="h-[60vh]" />
        </Card>
      </div>
    </div>
  );
}
