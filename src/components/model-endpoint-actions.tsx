"use client";

import { useState, useSyncExternalStore } from "react";
import { Check, ExternalLink, Link2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { toast } from "@/components/toast-store";
import { copyTextToClipboard } from "@/lib/clipboard";
import { buildApiBaseUrl } from "@/lib/curl-snippet";

/** useSyncExternalStore 的订阅位：location 在页面生命周期内不变，无需真实订阅 */
const subscribeNoop = (): (() => void) => () => {};

/**
 * 运行中模型的两个入口（多模型并行，决策 D8）：新标签页打开 llama.cpp 自带 web UI、
 * 复制模型服务地址。放在概览运行卡的端口行与模型列表运行行的端口列。
 *
 * 地址 = 浏览器当前 hostname + 模型实际端口，与「复制 curl」同一口径（lib/curl-snippet.ts）：
 * 面板与 llama-server 的端口发布在同一台宿主机。panel.yaml 的 chat.base_url 只管 Chat 页
 * 页头那个外链（指向默认模型），这里按模型逐个给入口，不读那个配置。
 *
 * 必须是 client 组件：SSR 与水合首帧拿不到 hostname，此时不渲染，不给出一个点了会坏的链接。
 */
export function ModelEndpointActions({ hostPort }: { hostPort: number }) {
  const t = useTranslations("common");
  const [copied, setCopied] = useState(false);
  const hostname = useSyncExternalStore(
    subscribeNoop,
    () => window.location.hostname,
    () => null as string | null,
  );

  if (hostname === null) return null;
  const baseUrl = buildApiBaseUrl(hostname, hostPort);

  async function onCopy() {
    const ok = await copyTextToClipboard(baseUrl);
    if (ok) {
      setCopied(true);
      toast.success(t("copyAddressDone", { url: baseUrl }));
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error(t("copyFailed"));
    }
  }

  return (
    <span className="inline-flex items-center">
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground"
        aria-label={t("openLlamaUi")}
        title={t("openLlamaUi")}
        nativeButton={false}
        render={<a href={baseUrl} target="_blank" rel="noreferrer" />}
      >
        <ExternalLink className="size-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="text-muted-foreground"
        aria-label={t("copyAddress")}
        title={t("copyAddress")}
        onClick={onCopy}
      >
        {copied ? <Check className="size-3.5 text-accent-green" /> : <Link2 className="size-3.5" />}
      </Button>
    </span>
  );
}
