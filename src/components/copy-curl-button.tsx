"use client";

import { useState } from "react";
import { Check, ClipboardCopy } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { toast } from "@/components/toast-store";
import { copyTextToClipboard } from "@/lib/clipboard";
import { buildCurlCommand } from "@/lib/curl-snippet";

/**
 * 「复制 curl」按钮（UX P0 Task 6 / U8）：把运行中 llama-server 的
 * OpenAI 兼容调用示例复制到剪贴板。host 取浏览器当前 hostname——局域网 /
 * SSH 隧道场景下用户从哪访问面板，模型端口就以哪个主机名可达。
 *
 * 放置：概览运行卡端口行、Chat 页运行 chip 旁。
 */
export function CopyCurlButton({ hostPort, size = "sm" }: { hostPort: number; size?: "sm" | "icon" }) {
  const t = useTranslations("common");
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    const host = typeof window !== "undefined" ? window.location.hostname : "localhost";
    const ok = await copyTextToClipboard(buildCurlCommand(host, hostPort));
    if (ok) {
      setCopied(true);
      toast.success(t("copyCurlDone"));
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error(t("copyFailed"));
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size={size === "icon" ? "icon" : "sm"}
      className="text-muted-foreground"
      aria-label={t("copyCurl")}
      title={t("copyCurl")}
      onClick={onCopy}
    >
      {copied ? <Check className="size-3.5 text-accent-green" /> : <ClipboardCopy className="size-3.5" />}
      {size === "sm" && (copied ? t("copied") : t("copyCurl"))}
    </Button>
  );
}
