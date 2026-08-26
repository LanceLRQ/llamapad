"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";

import { resolveChatBase, type ChatBaseResult } from "@/core/chatTarget";
import { apiFetch } from "@/lib/api";

/** useSyncExternalStore 的订阅位：location 在页面生命周期内不变，无需真实订阅 */
const subscribeNoop = (): (() => void) => () => {};

/**
 * Chat iframe（M5）：直连 llama-server 而非走面板反代——web UI 的根绝对路径在反代下必然 404。
 * 目标地址依赖 window.location，故必须是 client 组件；SSR 首帧无 origin（渲染占位边框），
 * 水合后按浏览器地址计算——不用 useEffect+setState（触发 set-state-in-effect，惯例同 theme-toggle）。
 */
export function ChatFrame({
  configuredBase,
  hostPort,
}: {
  configuredBase: string | null;
  hostPort: number | null;
}) {
  const t = useTranslations("pages.chat");
  // 服务端快照 null：SSR 与水合首帧渲染占位；客户端快照取当前 origin，水合完成立即生效
  const origin = useSyncExternalStore(
    subscribeNoop,
    () => window.location.origin,
    () => null as string | null,
  );

  const target: ChatBaseResult | null =
    origin === null
      ? null
      : resolveChatBase({ configured: configuredBase, origin, hostPort });

  // 首启动引导第四步「打开过 Playground」（UX P1 U22）打标：ChatFrame 只在有模型
  // 运行时才被父组件渲染，挂载即视为「打开过」，不等 iframe 目标解析完成；
  // fire-and-forget，失败不提示，不影响 Chat 页可用性
  useEffect(() => {
    apiFetch("/api/v1/settings/onboarding_playground_seen", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "1" }),
    }).catch(() => {});
  }, []);

  if (target === null) {
    return <div className="flex-1 rounded-lg border border-dashed" aria-hidden />;
  }

  if (target.url === null) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed p-8">
        <p className="max-w-md text-center text-sm text-muted-foreground">
          {target.blocked === "mixed-content" ? t("blockedMixedContent") : t("blockedNoTarget")}
        </p>
      </div>
    );
  }

  return (
    <>
      <iframe src={target.url} title={t("iframeTitle")} className="min-h-0 w-full flex-1 rounded-lg border-0" />
      <a
        href={target.url}
        target="_blank"
        rel="noreferrer"
        className="self-end text-xs text-muted-foreground underline-offset-4 hover:underline"
      >
        {t("openExternal")}
      </a>
    </>
  );
}
