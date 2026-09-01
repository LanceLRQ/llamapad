"use client";

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

import { CodeBlock } from "@/components/code-block";
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
 *
 * CodeBlock 已抽到 components/code-block.tsx（文档中心批 2）：新增的
 * docs-markdown.tsx 与本组件共用同一份代码块外壳，两处渲染器的差异只在
 * 宿主容器类名与链接/标题的处理策略上，行为不变。
 */
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("chat-markdown text-sm leading-relaxed", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          // 对话是内存态、刷新即丢；模型输出的链接若同标签页跳转会把整段对话冲掉，
          // 且链接来自不可信的模型输出，同标签页导航还会把面板地址当 Referer 发出去。
          // node 是 react-markdown 塞进 props 的 hast 节点（ExtraProps），不是
          // 合法 DOM 属性，{...props} 展开前摘掉丢弃，否则会渲染出非法的
          // <a node="[object Object]"> 属性（文档中心批 2 排查到的同款问题）
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer nofollow" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
