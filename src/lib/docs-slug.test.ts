import { describe, expect, it } from "vitest";

import { createHeadingSlugger, slugifyHeading } from "./docs-slug";

describe("slugifyHeading", () => {
  it("英文标题：转小写、空格转连字符", () => {
    expect(slugifyHeading("Quick Start")).toBe("quick-start");
  });

  it("剥离标点，不留多余连字符", () => {
    expect(slugifyHeading("FAQ: What's this?")).toBe("faq-whats-this");
  });

  it("保留数字", () => {
    expect(slugifyHeading("GPU 3090 配置")).toBe("gpu-3090-配置");
  });

  it("保留下划线与连字符", () => {
    expect(slugifyHeading("foo_bar-baz")).toBe("foo_bar-baz");
  });

  it("中文标题可用，不被剥成空串", () => {
    expect(slugifyHeading("快速开始")).toBe("快速开始");
  });

  it("中英混排：中间空格转连字符，中文本身不拆字", () => {
    expect(slugifyHeading("部署 Deployment 指南")).toBe("部署-deployment-指南");
  });

  it("首尾空白与连续空格：trim 后折叠成单个连字符", () => {
    expect(slugifyHeading("  Hello   World  ")).toBe("hello-world");
  });
});

describe("createHeadingSlugger", () => {
  it("同名标题去重：第二次加 -1，第三次加 -2", () => {
    const slug = createHeadingSlugger();
    expect(slug("配置")).toBe("配置");
    expect(slug("配置")).toBe("配置-1");
    expect(slug("配置")).toBe("配置-2");
  });

  it("不同标题互不影响计数", () => {
    const slug = createHeadingSlugger();
    expect(slug("安装")).toBe("安装");
    expect(slug("配置")).toBe("配置");
    expect(slug("安装")).toBe("安装-1");
  });

  it("每次调用工厂函数都是独立状态，不共享模块级计数", () => {
    const sluggerA = createHeadingSlugger();
    const sluggerB = createHeadingSlugger();
    expect(sluggerA("配置")).toBe("配置");
    // 新文档（新工厂实例）重新从头计数，不受上一篇文档影响——
    // 这正是不允许用模块级可变状态的原因（并发请求会互相污染）
    expect(sluggerB("配置")).toBe("配置");
  });
});
