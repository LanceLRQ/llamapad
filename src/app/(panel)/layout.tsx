import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { ConnectionBanner } from "@/components/shell/connection-banner";
import { RuntimeEventsWatcher } from "@/components/shell/runtime-events-watcher";
import { Sidebar } from "@/components/shell/sidebar";
import { Topbar } from "@/components/shell/topbar";
import {
  SESSION_COOKIE,
  getOrCreateSessionSecret,
  verifySession,
} from "@/server/auth";
import { getDb } from "@/server/db";
import { ensureEventRetentionTimer, getMetricsCollector, getWebhookDispatcher } from "@/server/locators";

// 读 cookie + better-sqlite3（原生模块）→ 全动态渲染，禁止 build 期预渲染触碰真实库文件
export const dynamic = "force-dynamic";

/** 面板路由组 layout：未持合法 session 一律重定向 /login（与 API 层共用同一校验） */
export default async function PanelLayout({ children }: { children: ReactNode }) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) redirect("/login");

  const secret = getOrCreateSessionSecret(getDb());
  if (!verifySession(token, secret)) redirect("/login");

  // 指标采集自面板可用即开始（设计 §9.1）：挂在 layout 首渲染而非 metrics API
  // 惰性触发，避免"没人打开图表页就不采数据"的空洞；globalThis 单例幂等
  getMetricsCollector();
  // Webhook 出站派发器同款惰性触发（UX P1 U24）：不依赖用户打开设置页，
  // 面板一可用轮询即在跑，事件才不会等到有人点进设置页才开始出站
  getWebhookDispatcher();
  // events 保留期巡检同款惰性触发：清理任务没有对应页面可挂，只能搭面板
  // 首渲染这班车，否则定时器永远不会被点着，90 天保留形同虚设
  ensureEventRetentionTimer();

  return (
    <div className="flex min-h-screen w-full bg-background text-foreground">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <ConnectionBanner />
        <Topbar />
        {/* 内容区全宽铺满（规范：无 max-width），密度对照 demo 的 28/34/48px 内边距 */}
        <main className="w-full flex-1 px-[34px] pt-7 pb-12">{children}</main>
      </div>
      {/* 运行时坏消息（容器异常退出/启动失败）toast 化（UX P0 Task 9） */}
      <RuntimeEventsWatcher />
    </div>
  );
}
