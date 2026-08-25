import { getTranslations } from "next-intl/server";

import { Badge } from "@/components/ui/badge";
import { DownloadsBadge } from "@/components/shell/downloads-badge";
import { TopbarActions } from "@/components/shell/topbar-actions";
import { getDb } from "@/server/db";
import { getRuntimeService } from "@/server/locators";
import { decorateRuntimeStatus } from "@/server/modelsView";

/**
 * 应用壳顶栏（server 组件，M1 Task 9 起接真实运行状态）。
 * 左侧固定 "llamapad"；右侧：运行状态 chip（真实数据）· 主题 / 语言切换 ·
 * 头像菜单（登出，client 部分拆在 topbar-actions.tsx）。
 *
 * chip 数据：getRuntimeStatus 从容器 label 推导（无内存状态），displayName /
 * hostPort 经 decorateRuntimeStatus 从 repo 模型行补齐。每个面板页都会渲染
 * 顶栏——mock 适配器是内存表，真实 dockerode 是一次 listContainers HTTP，
 * M1 可接受（缓存留 M3）。
 */
export async function Topbar() {
  const t = await getTranslations("topbar");

  // docker 查询失败（socket 异常等）时按"未运行"展示，不让顶栏炸掉整页
  let running: { displayName: string; container: string } | null = null;
  try {
    const status = await decorateRuntimeStatus(getDb(), getRuntimeService());
    if (status.running) {
      running = {
        displayName: status.running.displayName,
        container: status.running.container,
      };
    }
  } catch {
    running = null;
  }

  return (
    <header className="sticky top-0 z-10 flex h-[58px] flex-none items-center gap-3.5 border-b bg-background/80 px-[34px] backdrop-blur">
      <h1 className="text-base font-semibold tracking-tight">llamapad</h1>

      <div className="flex-1" />

      {/* 运行状态 chip：绿点 + 模型展示名（hover 显容器名）/ 灰点未运行 */}
      {running ? (
        <Badge
          variant="outline"
          title={running.container}
          className="gap-1.5 text-xs text-foreground"
        >
          <span className="size-1.5 rounded-full bg-accent-green" />
          {running.displayName}
        </Badge>
      ) : (
        <Badge variant="outline" className="gap-1.5 text-xs text-muted-foreground">
          <span className="size-1.5 rounded-full bg-muted-foreground/50" />
          {t("statusIdle")}
        </Badge>
      )}

      {/* 下载进展徽标（UX P0 Task 10）：订阅 SSE，无未完成任务时不占位 */}
      <DownloadsBadge />

      <TopbarActions />
    </header>
  );
}
