"use client";

import { useState } from "react";
import { Check, ClipboardCopy } from "lucide-react";
import { useTranslations } from "next-intl";

import { toast } from "@/components/toast-store";
import { copyTextToClipboard } from "@/lib/clipboard";

/**
 * 只读值 + 复制按钮。剪贴板走 copyTextToClipboard（面板常在 HTTP 局域网下访问，
 * navigator.clipboard 不可用，该函数带回退）；失败必须提示，不能静默。
 */
export function CopyField({ value, mono = true }: { value: string; mono?: boolean }) {
  const t = useTranslations("pages.relay");
  const tc = useTranslations("common");
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    if (await copyTextToClipboard(value)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error(tc("copyFailed"));
    }
  }

  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className={mono ? "truncate font-mono text-[13px]" : "truncate text-[13px]"}>{value}</span>
      <button
        type="button"
        onClick={onCopy}
        aria-label={t("copy")}
        title={t("copy")}
        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        {copied ? <Check className="size-3.5 text-accent-green" /> : <ClipboardCopy className="size-3.5" />}
      </button>
    </span>
  );
}
