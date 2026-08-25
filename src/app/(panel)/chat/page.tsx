import Link from "next/link";
import { ArrowRight, ExternalLink, MessageSquare } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getDb } from "@/server/db";
import { getRuntimeService } from "@/server/locators";
import { decorateRuntimeStatus, type RunningModelView } from "@/server/modelsView";

// 容器 label 查询 + better-sqlite3 → 全动态渲染
export const dynamic = "force-dynamic";

/** 反代根入口：iframe 与"在新窗口打开"共用（llama.cpp web UI 挂在上游 `/`） */
const PROXY_ROOT = "/api/v1/proxy/llama/";

/**
 * Chat / Playground 页（M3 Task 6，设计 §10）：server 侧判运行状态二选一渲染——
 * - 运行中：顶条（模型名 + 状态点 + 端口 + 外链）+ 全高 iframe 嵌 llama.cpp
 *   自带 web UI（SSH 隧道场景只暴露面板一个端口，web UI 的 fetch 走同源反代）
 * - 未运行：引导卡（先去 /models 启动），不渲染 iframe
 *
 * 数据源 decorateRuntimeStatus（容器 label 推导 + repo 行补 displayName/hostPort，
 * 与概览页 / 顶栏同源）。hostPort 为 null（容器在跑但模型行已删）时视同未运行——
 * 反代无目标端口，引导卡比 iframe 里的 503 JSON 更诚实。
 * 运行中途容器被停：页面不自动感知（server 组件无推送），iframe 内将显示反代
 * 的 503 JSON——可接受（顶栏 chip 已实时反映状态，刷新页面即回引导卡）。
 *
 * iframe 不加 sandbox：llama.cpp web UI 需以同源身份 fetch 面板反代下的
 * `/completion` 等 API（sandbox 默认 opaque origin 会让同源 fetch 变跨域被拒），
 * 上游是本面板自己管理的本地 llama-server，按同源信任处理。
 */
export default async function ChatPage() {
  const t = await getTranslations("pages.chat");
  const status = await decorateRuntimeStatus(getDb(), getRuntimeService());
  const running = status.running?.hostPort != null ? status.running : null;

  // 视口高度扣减（对照 (panel)/layout.tsx）：顶栏 58 + main 上内边距 28 + 下内边距 48
  return (
    <div className="flex h-[calc(100dvh-134px)] min-h-96 flex-col gap-4">
      {/* 顶条：标题 + 运行模型 chip / 外链 */}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <h1 className="text-base font-semibold tracking-tight">{t("title")}</h1>
        {running && <RunningChip running={running} label={t("statusRunning")} />}
        <div className="flex-1" />
        {running && (
          <Button
            variant="outline"
            size="sm"
            render={<a href={PROXY_ROOT} target="_blank" rel="noopener noreferrer" />}
          >
            {t("openExternal")}
            <ExternalLink data-icon="inline-end" className="size-3.5" />
          </Button>
        )}
      </div>

      {running ? (
        /* 全高 iframe：Card 只作圆角边框容器（overflow-hidden 裁圆角，无内边距） */
        <Card className="min-h-0 flex-1 gap-0 py-0">
          <iframe
            src={PROXY_ROOT}
            title={t("iframeTitle")}
            className="h-full w-full border-0"
          />
        </Card>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <MessageSquare className="size-6" />
            </span>
            <p className="text-sm font-medium">{t("idleTitle")}</p>
            <p className="max-w-md text-sm text-muted-foreground">{t("idleHint")}</p>
            <Button size="sm" render={<Link href="/models" />}>
              {t("gotoModels")}
              <ArrowRight data-icon="inline-end" className="size-3.5" />
            </Button>
          </CardContent>
        </Card>
      )}
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
