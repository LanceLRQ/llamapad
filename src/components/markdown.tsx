"use client";

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";

import { CodeBlock } from "@/components/code-block";
import { README_SANITIZE_SCHEMA } from "@/lib/markdown-sanitize";
import { cn } from "@/lib/utils";

/**
 * markdown 渲染，同时服务自建 Playground（渲染模型输出）与 README 视图。
 *
 * 两处的信任级别不同，靠 `allowHtml` 分流，而不是两份组件：
 * - Playground（`allowHtml` 缺省 = false）：模型输出是不可信文本，渲染其中的原始
 *   HTML 就是 XSS，react-markdown 默认不解析 HTML，保持默认即安全，插件数组只有
 *   `[rehypeHighlight]`，行为与本次改动之前完全一致。
 * - README 视图（`allowHtml = true`）：HuggingFace README 里常有原始 HTML 横幅
 *   （`<div><p style="…"><h1>…`），不开 HTML 就只能把标签当纯文本打印出来。开了之后
 *   必须经过 `lib/markdown-sanitize.ts` 的白名单消毒，schema 与取舍理由见该文件。
 *
 * `allowHtml` 为 true 时插件顺序是 `[rehypeRaw, [rehypeSanitize, SCHEMA],
 * rehypeHighlight]`，这个顺序不能变：rehypeRaw 先把 HTML 字符串解析成节点树
 * （此时可能混进恶意标签/属性）→ rehypeSanitize 立刻按白名单清洗，任何注入的东西
 * 在被后续插件碰到之前就已经被摘掉了 → rehypeHighlight 最后跑，它往 `code` 节点
 * 上加的 `hljs`/`language-*` className 因此不会被 sanitize 当成不认识的属性剥掉。
 * 顺序颠倒任意一处：raw 放最后会让 sanitize 白清洗一遍旧树、原始 HTML 照样漏进
 * DOM；sanitize 放最后会让 highlight 加的 class 被清掉、代码高亮失效。
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
export const Markdown = memo(function Markdown({
  text,
  className,
  urlTransform,
  allowHtml = false,
}: {
  text: string;
  className?: string;
  /** README 视图用：把仓库内相对链接改写成 HF 绝对地址（见 lib/readme-links.ts）。
   *  不传时用 react-markdown 自带的安全过滤，Playground 与既有调用方行为不变 */
  urlTransform?: (url: string, key: string, node: unknown) => string;
  /** 是否渲染正文里的原始 HTML（消毒后）。默认 false——只有 README 视图会传 true，
   *  Playground 依赖这个默认值保持零变化，见上方文件头注释 */
  allowHtml?: boolean;
}) {
  return (
    <div className={cn("chat-markdown text-sm leading-relaxed", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={
          allowHtml ? [rehypeRaw, [rehypeSanitize, README_SANITIZE_SCHEMA], rehypeHighlight] : [rehypeHighlight]
        }
        urlTransform={urlTransform}
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
