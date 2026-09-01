/**
 * 文档正文渲染前的内容变换（文档中心批 2）。与 docs-registry.ts 分开：
 * 那边是"扫描结果怎么装配成注册表"，这里是"正文字符串怎么改样子再交给
 * 渲染器"——两种职责，独立文件更内聚，也给批 3 可能出现的其它渲染前
 * 变换（如脚注、TOC 提取）留一个自然的落脚点。
 */

/** 单行是否恰好是 ATX 一级标题（"# 标题"，# 后必须跟空格/制表符 + 非空白字符；
 * "## 标题"因为 # 后紧跟的是另一个 #而不是空白，不会命中） */
function isAtxH1(line: string): boolean {
  return /^#[ \t]+\S/.test(line);
}

/**
 * 裁掉正文开头的一级标题（连同紧随其后的空行）——docs.ts 的 extractFirstHeading
 * 已经把同一个标题取出来给 PageHeader 展示了，渲染正文时不该再重复一次。
 *
 * 判定严格局限在"文档开头"：
 * - 只看首个非空行；不是一级标题（二级及以下、纯正文、代码块围栏……）一律
 *   原样返回，一个字节不改
 * - 正文中间出现的 "# 标题" 不受影响——只裁开头这一处
 * - 空文档 / 纯空白文档原样返回，不抛异常
 *
 * markdown 源文件本身必须保留这行 "# 标题"（GitHub 网页直接查看、
 * extractFirstHeading 取标题都要靠它），裁剪只发生在渲染前，不改源文件。
 */
export function stripLeadingHeading(content: string): string {
  const lines = content.split("\n");

  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length) return content; // 空文档/纯空白，无从判断，原样返回

  if (!isAtxH1(lines[i])) return content;

  const headingLineIndex = i;
  let after = headingLineIndex + 1;
  while (after < lines.length && lines[after].trim() === "") after++;

  return [...lines.slice(0, headingLineIndex), ...lines.slice(after)].join("\n");
}
