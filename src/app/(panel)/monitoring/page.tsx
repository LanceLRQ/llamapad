import type { ReactNode } from "react";
import { Activity, History, SquareTerminal } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { PageHeader } from "@/components/shell/page-header";
import { SecondaryNav } from "@/components/shell/secondary-nav";
import { LogTerminal } from "@/components/terminal";
import { Card } from "@/components/ui/card";
import { getMetricsCollector } from "@/server/locators";
import { cn } from "@/lib/utils";
import { MONITORING_TABS, resolveMonitoringTab } from "@/lib/monitoring-tabs";
import { MonitoringMetricCards } from "./metric-cards";
import { RunHistory } from "./run-history";

// 惰性采集单例（首次取用开跑心跳）→ 全动态渲染
export const dynamic = "force-dynamic";

const GROUP_ICON = { metrics: Activity, history: History, logs: SquareTerminal } as const;

/**
 * 监控页（M3 Task 5；本次改二级栏三组 + 按组切换，选中组走 URL query
 * `?tab=`，与设置页 M16 T4a 同构）：指标（GPU/容器/宿主机指标卡 + sparkline）/
 * 历史（模型启停记录）/ 容器日志（SSE 实时流）三组各自独占监控页，不再纵向
 * 堆叠在一屏。
 *
 * 拆分的实际收益：改造前打开监控页会同时挂起指标轮询、30s 运行历史轮询和
 * 一条日志 SSE 长连接三路后台活动；拆分后只有当前分组那一路在跑，切到别组
 * 时上一组的轮询/连接随组件卸载一并停掉。
 */
export default async function MonitoringPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const t = await getTranslations("pages.monitoring");
  const { tab: rawTab } = await searchParams;
  const tab = resolveMonitoringTab(rawTab);

  // 打开监控页即确保指标采集心跳在跑（幂等单例）；probe 结果直传 SSR 首帧。
  // 心跳与分组无关，三组都可能间接依赖（切回 metrics 组时不该冷启动一次）
  getMetricsCollector();

  let content: ReactNode;
  switch (tab) {
    case "metrics":
      content = (
        <MonitoringMetricCards initialGpuStatus={getMetricsCollector().nvidiaStatus()} />
      );
      break;
    case "history":
      content = <RunHistory />;
      break;
    case "logs":
      // Card 不只是装饰：圆角/描边/裁切都在它身上，终端自己不带边框，
      // 少这一层深色滚动体会直接怼到内容区边缘。min-h-0 flex-1 是把外层
      // 分到的高度继续传给终端（终端的 fill 从这里接力）
      content = (
        <Card size="sm" className="min-h-0 flex-1 gap-0 py-0">
          <LogTerminal streamUrl="/api/v1/logs/stream" fill />
        </Card>
      );
      break;
  }

  const navItems = MONITORING_TABS.map(({ key, number }) => ({
    key,
    name: t(`groups.${key}.name`),
    meta: t(`groups.${key}.meta`),
    lead: { kind: "number" as const, text: number },
  }));

  return (
    // 二级栏必须贴到应用外壳的框边：T1 给 main 留了 px-[34px] pt-7 pb-12，
    // 本页在这一层用负边距抵消掉。这是 T1→T11 迁移期的过渡做法，T4b 之后
    // 各页统一处理，届时这段注释与负边距一起删。
    //
    // 高度按分组分叉，但两个分支的 100%+76px 是同一个数：76px 是把上面抵消掉的
    // pt-7 28 + pb-12 48 原样加回来（算式与 chat/page.tsx 同源同理由——三个数字
    // 在同一个元素上，要改一起改）。logs 组用定高 h-，终端要靠它才能撑满；
    // metrics/history 组用 min-h-，内容可继续往下长、交给 main 滚动。
    // 两边都写成 +76px 而不是沿用 settings/files 的 min-h-full，是因为
    // min-h-full 只等于 main 的内容盒，二级栏那条右边框会停在离底 76px 的地方——
    // 页面之间看不出来，同一页切 tab 却会看见这条线跳一下
    <div
      className={cn(
        "-mx-[34px] -mt-7 -mb-12 flex",
        tab === "logs" ? "h-[calc(100%+76px)] min-h-96" : "min-h-[calc(100%+76px)]",
      )}
    >
      <SecondaryNav
        kicker="MONITORING"
        title={t("title")}
        items={navItems}
        queryKey="tab"
        current={tab}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader
          icon={GROUP_ICON[tab]}
          title={t(`groups.${tab}.name`)}
          subtitle={t(`groups.${tab}.subtitle`)}
        />
        {tab === "logs" ? (
          <div className="flex min-h-0 flex-1 flex-col px-7 py-6">{content}</div>
        ) : (
          <div className="flex flex-col gap-4 px-7 py-6">{content}</div>
        )}
      </div>
    </div>
  );
}
