"use client";

import { useSyncExternalStore } from "react";
import { ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { resolveWebuiUrl } from "@/core/chatTarget";

/** useSyncExternalStore 的订阅位：location 在页面生命周期内不变，无需真实订阅 */
const subscribeNoop = (): (() => void) => () => {};

/**
 * 页头「打开 llama UI」外链：llama.cpp 自带 web UI 从内嵌 iframe 降级为外链之后的入口。
 *
 * 必须是 client 组件——目标地址要按浏览器当前 hostname 推导（面板与 llama-server 的端口
 * 发布在同一台宿主机）。SSR 与水合首帧没有 origin，此时不渲染按钮而不是渲染一个坏链接。
 * 地址推导（含 chat.base_url 优先、no-port / bad-origin 判定）见 core/chatTarget.ts。
 */
export function OpenWebuiButton({
  configuredBase,
  hostPort,
}: {
  configuredBase: string | null;
  hostPort: number | null;
}) {
  const t = useTranslations("pages.chat");
  const origin = useSyncExternalStore(
    subscribeNoop,
    () => window.location.origin,
    () => null as string | null,
  );

  if (origin === null) return null;
  const target = resolveWebuiUrl({ configured: configuredBase, origin, hostPort });
  // 推导不出地址时不给一个点了会坏的按钮：Playground 本身可用，外链只是补充入口，
  // 原因（端口缺失 / origin 非法）挂在 title 上，不占页头版面
  if (target.url === null) {
    return (
      <Button variant="ghost" size="xs" disabled title={t("blockedNoTarget")}>
        <ExternalLink className="size-3.5" />
        {t("openWebui")}
      </Button>
    );
  }

  return (
    <Button
      variant="ghost"
      size="xs"
      nativeButton={false}
      render={<a href={target.url} target="_blank" rel="noreferrer" />}
    >
      <ExternalLink className="size-3.5" />
      {t("openWebui")}
    </Button>
  );
}
