import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { RuntimeEventsWatcher } from "@/components/shell/runtime-events-watcher";
import { Sidebar } from "@/components/shell/sidebar";
import { StatusBar } from "@/components/shell/status-bar";
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
    // 应用外壳（M16 T1）：四周 14px 留白 + 外底色（--shell），内嵌一个两列
    // grid 画框——第 1 行 [侧栏, 内容]，第 2 行状态栏跨两列。frame 只管这两列，
    // 二级栏（若某页有）在 main 内部自己排，layout 不需要知道当前页有没有它。
    //
    // grid-rows 用 minmax(0,1fr) 而非 1fr：grid 行默认 min-height:auto，内容
    // 一高就会撑破画框把状态栏顶出视口；同理 frame 的每个直接子元素都要
    // min-h-0，否则子元素自身的隐式最小高度会先一步撑破所在行。
    <div className="flex h-screen w-full flex-col bg-shell p-3.5">
      <div className="grid min-h-0 flex-1 grid-cols-[236px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto] overflow-hidden rounded-xl border bg-background text-foreground">
        <Sidebar />
        {/* 内容区全宽铺满（规范：无 max-width），密度对照 demo 的 28/34/48px 内边距。
            padding 拆进各页是 T4–T11 的事，这里先保留现状，避免全站页面在
            T1→T11 迁移期间一直贴死框边 */}
        <main className="min-h-0 w-full overflow-y-auto px-[34px] pt-7 pb-12">{children}</main>
        <StatusBar />
      </div>
      {/* 运行时坏消息（容器异常退出/启动失败）toast 化（UX P0 Task 9） */}
      <RuntimeEventsWatcher />
    </div>
  );
}
