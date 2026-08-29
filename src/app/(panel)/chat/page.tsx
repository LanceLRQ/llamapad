import Link from "next/link";
import { ArrowRight, MessageSquare } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CopyCurlButton } from "@/components/copy-curl-button";
import { getDb } from "@/server/db";
import { getRuntimeService } from "@/server/locators";
import { decorateRuntimeStatus, type RunningModelView } from "@/server/modelsView";
import { getPanelConfig } from "@/server/panelConfig";

import { ChatFrame } from "./chat-frame";
import { ChatLoading } from "./chat-loading";

// 容器 label 查询 + better-sqlite3 → 全动态渲染
export const dynamic = "force-dynamic";

/**
 * Chat / Playground 页（M3 Task 6，设计 §10；M5 改直连；真机缺陷修复改三分支）：
 * server 侧判运行状态三选一渲染——
 * - 运行中且已就绪：顶条（模型名 + 状态点 + 端口）+ ChatFrame 全高 iframe 嵌 llama.cpp 自带 web UI
 * - 运行中但未就绪：ChatLoading 过渡卡片（容器已起、模型还在加载，见其文件头注释）
 * - 未运行：引导卡（先去 /models 启动），不渲染 iframe
 *
 * 直连而非反代（M5 关闭挂账②）：web UI 的 bundle 内含根绝对路径（/v1/models、/props、
 * /tools），经面板反代 /api/v1/proxy/llama/ 必然 404；iframe 直连 llama-server 根路径则
 * 天然正确。跨源 iframe 内的 web UI 只 fetch 自身 origin，无 CORS 问题——但 iframe 不能加
 * sandbox（opaque origin 会让其 fetch 自身 API 也被 CORS 拒掉），上游是本面板自己管理的
 * 本地 llama-server，按直连信任处理。目标地址推导见 core/chatTarget.ts（panel.yaml 的
 * chat.base_url 显式配置优先，否则按浏览器 hostname + 模型 host_port 推导）。
 *
 * 数据源 decorateRuntimeStatus（容器 label 推导 + repo 行补 displayName/hostPort/ready，
 * 与概览页 / 顶栏同源）。hostPort 为 null（容器在跑但模型行已删）时视同未运行——
 * 无目标端口，引导卡比 iframe 里的连接失败页更诚实。ready 为 false（容器起了，
 * llama-server 还没监听）时既不该渲染 iframe（连接失败页比空转更误导）也不该退回
 * 引导卡（会让用户误以为需要重新点启动），故单列 ChatLoading 分支。
 * 运行中途容器被停：页面不自动感知（server 组件无推送），iframe 内将显示浏览器自身的
 * 连接失败页——可接受（顶栏 chip 已实时反映状态，刷新页面即回引导卡）。
 */
export default async function ChatPage() {
  const t = await getTranslations("pages.chat");
  const status = await decorateRuntimeStatus(getDb(), getRuntimeService());
  const running = status.running?.hostPort != null ? status.running : null;

  // 高度不写死成视口算式：main 的高度由外壳 grid 行定死（(panel)/layout.tsx 的
  // grid-rows-[minmax(0,1fr)_auto]），本页按百分比取满再用 flex 分剩余空间。
  // 那个 +76px 不是魔数，是把下面两条负边距抵消掉的 main 内边距原样加回来
  // （pt-7 = 28 + pb-12 = 48）——h-full 只等于 main 的内容盒，不含这 76px，
  // 不加回来 iframe 底下会空出一条。三个数字在同一个元素上，要改一起改。
  return (
    // PageHeader 自带 border-b + px-7：内边距的控制权要交给页面自己，才能让这条
    // border-b 与其它套了同款外壳的页面一样通栏（与有没有二级栏无关）。T1 给 main
    // 留了 px-[34px] pt-7 pb-12，这里用负边距抵消，内容区再用 px-7 py-6 接回来。
    // 这是 T1→T11 迁移期的过渡做法，之后各页统一处理，届时这段注释与负边距一起删。
    <div className="-mx-[34px] -mt-7 -mb-12 flex h-[calc(100%+76px)] min-h-96 flex-col">
      {/* 顶栏：标题 + 运行模型 chip + API 调用示例复制（UX P0 Task 6） */}
      <PageHeader
        icon={MessageSquare}
        title={t("title")}
        subtitle={t("description")}
        trailing={
          running ? (
            <div className="flex items-center gap-2.5">
              <RunningChip running={running} label={t("statusRunning")} />
              {running.hostPort != null && <CopyCurlButton hostPort={running.hostPort} />}
            </div>
          ) : undefined
        }
      />

      <div className="flex min-h-0 flex-1 flex-col gap-4 px-7 py-6">
        {running?.ready ? (
          /* 直连 iframe（client 组件）：目标推导、blocked 提示与新窗口外链都在其内 */
          <ChatFrame
            configuredBase={getPanelConfig().chat.base_url ?? null}
            hostPort={running.hostPort}
          />
        ) : running ? (
          /* 容器已起、模型还在加载：轮询就绪状态，翻真后 router.refresh() 自动换成上面的分支 */
          <ChatLoading />
        ) : (
          <Card>
            <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
              <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                <MessageSquare className="size-6" />
              </span>
              <p className="text-sm font-medium">{t("idleTitle")}</p>
              <p className="max-w-md text-sm text-muted-foreground">{t("idleHint")}</p>
              <Button size="sm" nativeButton={false} render={<Link href="/models" />}>
                {t("gotoModels")}
                <ArrowRight data-icon="inline-end" className="size-3.5" />
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

/** 运行模型 chip：绿点 + displayName + :host_port（hover 显容器名） */
function RunningChip({ running, label }: { running: RunningModelView; label: string }) {
  return (
    <Badge
      variant="outline"
      title={running.container}
      className="gap-1.5 text-xs text-foreground"
    >
      <span className="size-1.5 rounded-full bg-accent-green" />
      {running.displayName}
      <span className="font-mono tabular-nums text-muted-foreground">:{running.hostPort}</span>
      <span className="text-muted-foreground">·</span>
      <span className="text-muted-foreground">{label}</span>
    </Badge>
  );
}
