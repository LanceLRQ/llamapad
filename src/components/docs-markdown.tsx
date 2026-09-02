"use client";

import { isValidElement, useMemo, type ReactNode } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

import { CodeBlock } from "@/components/code-block";
import { createHeadingSlugger } from "@/lib/docs-slug";
import { rewriteDocImageSrc, rewriteDocLink } from "@/lib/docs-links";

/**
 * 文档中心正文渲染（文档中心批 2）：与 components/markdown.tsx（Playground
 * 用）共用同一个 CodeBlock，但有三处语义相反，改动前务必先确认没有破坏：
 *
 * ① 站内链接走 Next <Link>（应用内导航，不整页刷新）；只有外链才开新标签
 *    （target="_blank" rel="noreferrer"，不加 nofollow —— Playground 那版
 *    加 nofollow 是因为链接来自不可信的模型输出，这里的文档是我们自己写
 *    的，没有理由让搜索引擎不追踪自家文档）
 * ② 需要标题锚点：h2/h3 用 lib/docs-slug.ts 的 slugger 生成 id。slugger 用
 *    useMemo 按正文内容重建（不是模块级/组件级贯穿多篇文档的可变状态），
 *    切换到另一篇文档时去重计数器必须归零，否则文档 A 用过的编号会污染
 *    文档 B 的第一个同名标题
 * ③ 长文排版（.docs-markdown，见 globals.css），不是聊天气泡的紧凑排版
 *
 * 链接/图片的路径改写规则见 lib/docs-links.ts（纯字符串判定，已有测试）；
 * 不引 rehype-raw 的理由与 Playground 版相同——该决策是全站统一的既定
 * 安全选择，与内容是否可信无关。
 */

/** 从 react-markdown 传给标题组件的 children（可能嵌套加粗/行内代码等元素）
 * 里拼出纯文本，供 slugger 生成锚点 id。只走数据结构遍历，不碰 DOM。 */
function headingText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(headingText).join("");
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return headingText(props.children);
  }
  return "";
}

function makeHeadingComponent(tagName: "h2" | "h3", slugger: (heading: string) => string) {
  return function Heading({ children }: { children?: ReactNode }) {
    const Tag = tagName;
    return <Tag id={slugger(headingText(children))}>{children}</Tag>;
  };
}

export function DocsMarkdown({ text }: { text: string }) {
  // 每篇文档独立一份 slugger：按正文内容重建，文档切换时计数器归零，
  // 不与上一篇共享状态——同名标题去重是"单篇文档内"的语义。createHeadingSlugger
  // 本身不读 text，但依赖数组必须留着 text——它是"何时该重建"的触发信号，
  // 不是被工厂函数消费的参数
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const slugger = useMemo(() => createHeadingSlugger(), [text]);

  return (
    <div className="docs-markdown text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          // 表格套一层横向滚动容器：API 端点表这类宽表在窄窗口下会把
          // min-w-0 的正文列撑开，表现为整页横滚（正文区是 overflow-y-auto，
          // 横向溢出会冒到页面上）。让表格在自己这一格里滚，页面不受影响
          table: ({ node: _node, ...props }) => (
            <div className="overflow-x-auto">
              <table {...props} />
            </div>
          ),
          h2: makeHeadingComponent("h2", slugger),
          h3: makeHeadingComponent("h3", slugger),
          // node 是 react-markdown 额外塞进 props 的 hast 节点（ExtraProps），
          // 不是合法的 DOM 属性——{...props} 展开前必须把它摘掉丢弃，否则会
          // 序列化成 <a node="[object Object]"> 这种非法属性渲染进真实 DOM
          a: ({ href, children, node: _node, ...props }) => {
            if (!href) return <a {...props}>{children}</a>;
            const result = rewriteDocLink(href);
            if (result.kind === "doc") {
              return (
                <Link href={result.href} {...props}>
                  {children}
                </Link>
              );
            }
            if (result.kind === "external") {
              return (
                <a href={result.href} target="_blank" rel="noreferrer" {...props}>
                  {children}
                </a>
              );
            }
            return (
              <a href={result.href} {...props}>
                {children}
              </a>
            );
          },
          img: ({ src, alt, node: _node, ...props }) => {
            const resolvedSrc = typeof src === "string" ? rewriteDocImageSrc(src) : src;
            // 文档图片来自本地 markdown 相对路径，尺寸未知；批 2 尚未建
            // /docs-media 图片服务路由（批 4 的事），这里先用普通 <img>，
            // 不引 next/image（它强制要求预知宽高）
            // eslint-disable-next-line @next/next/no-img-element
            return <img src={resolvedSrc} alt={alt ?? ""} {...props} />;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
