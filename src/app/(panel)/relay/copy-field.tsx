"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ClipboardCopy } from "lucide-react";
import { useTranslations } from "next-intl";

import { toast } from "@/components/toast-store";
import { copyTextToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

/**
 * 复制交互：剪贴板走 copyTextToClipboard（面板常在 HTTP 局域网下访问，
 * navigator.clipboard 不可用，该函数带回退）；失败必须提示，不能静默。
 * copied 在成功后保持 2 秒，供按钮切换成「已复制」图标。
 */
export function useCopy() {
  const tc = useTranslations("common");
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  async function copy(value: string) {
    if (await copyTextToClipboard(value)) {
      setCopied(true);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error(tc("copyFailed"));
    }
  }

  return { copied, copy };
}

/** 复制按钮本体（图标按钮）；点击不向外冒泡，免得触发所在行的展开 / 整行复制 */
export function CopyButton({
  value,
  className,
  ref,
}: {
  value: string;
  className?: string;
  ref?: React.Ref<HTMLButtonElement>;
}) {
  const t = useTranslations("pages.relay");
  const { copied, copy } = useCopy();
  return (
    <button
      ref={ref}
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void copy(value);
      }}
      aria-label={t("copy")}
      title={t("copy")}
      className={cn("shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground", className)}
    >
      {copied ? <Check className="size-3.5 text-accent-green" /> : <ClipboardCopy className="size-3.5" />}
    </button>
  );
}

/**
 * 只读值 + 复制按钮。两种外观：
 * - inline（默认）：纯文字后跟图标，用于一行一值的场合
 * - chip：带底色与边框的小条，用于「可复制的名字」；tag 是左侧的小标签（如「名称」「别名」），
 *   children 跟在复制按钮之后（如「→ 实际转发的模型名」）
 */
export function CopyField({
  value,
  mono = true,
  variant = "inline",
  tag,
  small = false,
  children,
}: {
  value: string;
  mono?: boolean;
  variant?: "inline" | "chip";
  tag?: string;
  small?: boolean;
  children?: React.ReactNode;
}) {
  const textSize = small ? "text-xs" : "text-[13px]";

  if (variant === "chip") {
    return (
      <span
        className={cn(
          "inline-flex min-h-6.5 max-w-full min-w-0 items-center rounded-lg border bg-muted pr-0.5 pl-2",
          textSize,
        )}
      >
        {tag !== undefined && (
          <span className="mr-1.5 shrink-0 border-r pr-1.5 text-xs leading-4 text-muted-foreground">{tag}</span>
        )}
        <span className={cn("min-w-0 [overflow-wrap:anywhere]", mono && "font-mono")}>{value}</span>
        <CopyButton value={value} className="ml-0.5" />
        {children !== undefined && (
          <span className="mr-1 ml-1 min-w-0 font-mono text-xs [overflow-wrap:anywhere] text-muted-foreground">
            {children}
          </span>
        )}
      </span>
    );
  }

  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className={cn("truncate", textSize, mono && "font-mono")} title={value}>
        {value}
      </span>
      <CopyButton value={value} />
    </span>
  );
}
