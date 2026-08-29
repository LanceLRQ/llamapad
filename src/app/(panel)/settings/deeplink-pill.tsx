"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { useTranslations } from "next-intl";

import { toast } from "@/components/toast-store";
import { copyTextToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

/**
 * 设置页顶栏深链胶囊（M16 T4a）：展示 `/settings?tab=xxx` 并提供一键复制完整
 * URL——四组分组切换全靠 query，胶囊让"当前看的是哪组"可以直接分享出去。
 *
 * 复制走 copyTextToClipboard（HTTP 局域网下会退到 execCommand），两条路都
 * 失败会返回 false，此时必须给可见的失败反馈，不能静默（参照
 * components/copy-curl-button.tsx 的既有做法：成功也弹 toast + 图标短暂变 √）。
 */
export function DeeplinkPill({ tab }: { tab: string }) {
  const t = useTranslations("pages.settings");
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const ok = await copyTextToClipboard(`${origin}/settings?tab=${tab}`);
    if (ok) {
      setCopied(true);
      toast.success(t("deeplinkCopied"));
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error(t("deeplinkCopyFailed"));
    }
  }

  return (
    <div className="flex h-[30px] items-center rounded-full border bg-card pl-[11px] pr-[5px] font-mono text-xs text-muted-foreground">
      <span className="truncate">
        /settings?tab=<span className="font-semibold text-foreground">{tab}</span>
      </span>
      <button
        type="button"
        aria-label={t("deeplinkCopy")}
        title={t("deeplinkCopy")}
        onClick={onCopy}
        className={cn(
          "ml-1.5 flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground",
          "hover:bg-foreground/[0.06] hover:text-foreground",
        )}
      >
        {copied ? <Check className="size-3 text-accent-green" /> : <Copy className="size-3" />}
      </button>
    </div>
  );
}
