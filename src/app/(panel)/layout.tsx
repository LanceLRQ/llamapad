import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { Sidebar } from "@/components/shell/sidebar";
import { Topbar } from "@/components/shell/topbar";
import {
  SESSION_COOKIE,
  getOrCreateSessionSecret,
  verifySession,
} from "@/server/auth";
import { getDb } from "@/server/db";

// 读 cookie + better-sqlite3（原生模块）→ 全动态渲染，禁止 build 期预渲染触碰真实库文件
export const dynamic = "force-dynamic";

/** 面板路由组 layout：未持合法 session 一律重定向 /login（与 API 层共用同一校验） */
export default async function PanelLayout({ children }: { children: ReactNode }) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) redirect("/login");

  const secret = getOrCreateSessionSecret(getDb());
  if (!verifySession(token, secret)) redirect("/login");

  return (
    <div className="flex min-h-screen w-full bg-background text-foreground">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        {/* 内容区全宽铺满（规范：无 max-width），密度对照 demo 的 28/34/48px 内边距 */}
        <main className="w-full flex-1 px-[34px] pt-7 pb-12">{children}</main>
      </div>
    </div>
  );
}
