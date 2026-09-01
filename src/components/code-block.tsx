"use client";

import { useRef, useState } from "react";
import { Check, ClipboardCopy } from "lucide-react";
import { useTranslations } from "next-intl";

import { copyTextToClipboard } from "@/lib/clipboard";
import { toast } from "@/components/toast-store";

/**
 * markdown 渲染专用的代码块外壳（文档中心批 2 从 components/markdown.tsx
 * 抽出，供 Playground 与文档中心两处 markdown 渲染器共用；两处唯一的差异
 * 是宿主容器的排版类名，代码块本身的行为必须一字不差）。
 *
 * 复制内容从 DOM 读 textContent，不从 children 取：react-markdown 传给 pre
 * 的 children 是 <code> React 元素（高亮插件还会在里面再嵌若干 <span>），
 * typeof 判字符串永远为假；按 props 逐层挖则会随高亮插件的结构变化而失效。
 *
 * 剪贴板走 copyTextToClipboard 的 execCommand 回退（面板主部署形态是 HTTP
 * 局域网访问，navigator.clipboard 在那里就是 undefined）；两条路都失败要
 * toast 报错，不能静默——用户会以为已经复制成功。
 */
export function CodeBlock({ children }: { children: React.ReactNode }) {
  const t = useTranslations("common");
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  async function onCopy() {
    const text = preRef.current?.textContent ?? "";
    if (text === "") return;
    if (await copyTextToClipboard(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error(t("copyFailed"));
    }
  }

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onCopy}
        aria-label={t("copyCode")}
        title={t("copyCode")}
        className="absolute top-2 right-2 rounded p-1 opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100"
      >
        {copied ? <Check className="size-3.5 text-accent-green" /> : <ClipboardCopy className="size-3.5" />}
      </button>
      <pre ref={preRef} className="overflow-x-auto rounded-md bg-[#101013] p-3 font-mono text-[12px] text-[#fafafa]">
        {children}
      </pre>
    </div>
  );
}
