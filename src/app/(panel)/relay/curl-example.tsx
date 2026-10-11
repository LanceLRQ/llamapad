"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";
import { CopyButton } from "./copy-field";

/** 示例请求：默认收成一行，点开才占高度；复制按钮常驻在标题行，不用先展开 */
export function CurlExample({ curl }: { curl: string }) {
  const t = useTranslations("pages.relay.access");
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-2 border-t pt-1.5">
      <div className="flex items-center justify-between">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1 py-0.5 pr-1 text-[13px] font-semibold"
        >
          <ChevronRight className={cn("size-4 transition-transform", open && "rotate-90")} />
          {t("example")}
        </button>
        <CopyButton value={curl} />
      </div>
      {open && (
        <pre className="mt-1.5 max-h-52 overflow-auto rounded-lg bg-[#101013] px-3 py-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap text-[#fafafa] [overflow-wrap:anywhere]">
          {curl}
        </pre>
      )}
    </div>
  );
}
