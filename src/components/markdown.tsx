"use client";

import { memo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, ClipboardCopy } from "lucide-react";
import { useTranslations } from "next-intl";

import { copyTextToClipboard } from "@/lib/clipboard";
import { toast } from "@/components/toast-store";
import { cn } from "@/lib/utils";

/**
 * 模型输出的 markdown 渲染（自建 Playground）
 *
 * 刻意不引 rehype-raw：模型输出是不可信文本，渲染其中的原始 HTML 就是 XSS。
 * react-markdown 默认不渲染 HTML，保持默认即安全。
 *
 * memo 是必需的而非优化：流式期间父组件每 80ms 重渲一次，不 memo 就会把
 * 整棵 markdown AST 重建一遍，长回复下肉眼可见卡顿。
 *
 * 代码高亮的配色不引 highlight.js 的两套 css 主题，改在 globals.css 里用
 * 面板既有的主题变量映射 .hljs-* 类——省掉一套明暗切换逻辑，也避免第三方
 * css 的选择器和 Tailwind 打架。
 */
function CodeBlock({ children }: { children: React.ReactNode }) {
  const t = useTranslations("common");
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  async function onCopy() {
    // 从 DOM 读 textContent，不从 children 取：react-markdown 传给 pre 的 children
    // 是 <code> React 元素（高亮插件还会在里面再嵌若干 <span>），typeof 判字符串
    // 永远为假；按 props 逐层挖则会随高亮插件的结构变化而失效
    const text = preRef.current?.textContent ?? "";
    if (text === "") return;
    if (await copyTextToClipboard(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      // clipboard.ts 的契约明写"两条路都失败返回 false——调用方必须据此给用户
      // 可见的失败反馈，绝不静默"。面板主部署形态是 HTTP 局域网，那里
      // navigator.clipboard 就是 undefined，回退再失败时用户会以为已复制
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

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("chat-markdown text-sm leading-relaxed", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
