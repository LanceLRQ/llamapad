import { describe, expect, it } from "vitest";

import { stripLeadingHeading } from "./docs-content";

describe("stripLeadingHeading", () => {
  it("首个非空行恰好是一级标题：裁掉标题行 + 紧随其后的空行", () => {
    expect(stripLeadingHeading("# 快速开始\n\n正文")).toBe("正文");
  });

  it("标题后有多个连续空行：一并裁掉，只留正文", () => {
    expect(stripLeadingHeading("# 快速开始\n\n\n正文")).toBe("正文");
  });

  it("标题后没有空行，直接接正文：只裁标题行本身", () => {
    expect(stripLeadingHeading("# 快速开始\n正文")).toBe("正文");
  });

  it("首个非空行是二级标题：原样返回，一个字节不改", () => {
    const content = "## 二级标题\n正文";
    expect(stripLeadingHeading(content)).toBe(content);
  });

  it("首个非空行不是标题：原样返回", () => {
    const content = "直接是正文，没有标题";
    expect(stripLeadingHeading(content)).toBe(content);
  });

  it("正文中间出现的一级标题不裁——只看开头", () => {
    const content = "正文第一段\n\n# 标题\n\n更多正文";
    expect(stripLeadingHeading(content)).toBe(content);
  });

  it("整篇文档以代码块开头：首个非空行是围栏 ```，不是 #，不裁", () => {
    const content = "```bash\n# 安装依赖（代码块里的注释，不是标题）\necho hi\n```\n\n正文";
    expect(stripLeadingHeading(content)).toBe(content);
  });

  it("#后面没有空格不算合法 ATX 标题，不裁", () => {
    const content = "#快速开始\n正文";
    expect(stripLeadingHeading(content)).toBe(content);
  });

  it("空文档：原样返回，不炸", () => {
    expect(stripLeadingHeading("")).toBe("");
  });

  it("纯空白文档：原样返回，不炸", () => {
    const content = "   \n\n   \n";
    expect(stripLeadingHeading(content)).toBe(content);
  });

  it("只有标题、没有正文：裁完得到空串，不炸", () => {
    expect(stripLeadingHeading("# 只有标题")).toBe("");
  });

  it("标题带 ATX 收尾 # 号同样识别为一级标题", () => {
    expect(stripLeadingHeading("# 快速开始 #\n\n正文")).toBe("正文");
  });
});
