import { describe, expect, it } from "vitest";

import { rewriteDocImageSrc, rewriteDocLink } from "./docs-links";

describe("rewriteDocLink：站内 .md 相对链接", () => {
  it("带 ./ 前缀 → 去掉前缀与扩展名，加 /docs/ 前缀", () => {
    expect(rewriteDocLink("./deployment.md")).toEqual({ kind: "doc", href: "/docs/deployment" });
  });

  it("不带前缀同样处理", () => {
    expect(rewriteDocLink("deployment.md")).toEqual({ kind: "doc", href: "/docs/deployment" });
  });

  it("锚点原样保留，且不参与 slug 匹配", () => {
    expect(rewriteDocLink("./deployment.md#https")).toEqual({
      kind: "doc",
      href: "/docs/deployment#https",
    });
  });

  it("查询串剥离", () => {
    expect(rewriteDocLink("./deployment.md?ref=1")).toEqual({ kind: "doc", href: "/docs/deployment" });
  });

  it("查询串 + 锚点：查询串剥离，锚点保留", () => {
    expect(rewriteDocLink("./deployment.md?ref=1#section")).toEqual({
      kind: "doc",
      href: "/docs/deployment#section",
    });
  });
});

describe("rewriteDocLink：纯锚点（同页跳转）", () => {
  it("原样保留，不重写", () => {
    expect(rewriteDocLink("#section")).toEqual({ kind: "raw", href: "#section" });
  });
});

describe("rewriteDocLink：外链", () => {
  it("http:// 原样返回并标记外链", () => {
    expect(rewriteDocLink("http://example.com")).toEqual({ kind: "external", href: "http://example.com" });
  });

  it("https:// 原样返回并标记外链", () => {
    expect(rewriteDocLink("https://example.com/x")).toEqual({
      kind: "external",
      href: "https://example.com/x",
    });
  });

  it("mailto: 原样返回并标记外链", () => {
    expect(rewriteDocLink("mailto:a@b.com")).toEqual({ kind: "external", href: "mailto:a@b.com" });
  });

  it("data: 原样返回并标记外链", () => {
    expect(rewriteDocLink("data:text/plain;base64,aGk=")).toEqual({
      kind: "external",
      href: "data:text/plain;base64,aGk=",
    });
  });
});

describe("rewriteDocLink：越出文档根", () => {
  it("../ 开头原样返回，不瞎猜", () => {
    expect(rewriteDocLink("../../README.md")).toEqual({ kind: "raw", href: "../../README.md" });
  });

  it("单层 ../ 同样原样返回", () => {
    expect(rewriteDocLink("../other.md")).toEqual({ kind: "raw", href: "../other.md" });
  });
});

describe("rewriteDocLink：非 .md 的相对链接", () => {
  it("原样返回，不当文档链接处理", () => {
    expect(rewriteDocLink("./assets/file.zip")).toEqual({ kind: "raw", href: "./assets/file.zip" });
  });
});

describe("rewriteDocImageSrc", () => {
  it("images/xxx.png → /docs-media/xxx.png", () => {
    expect(rewriteDocImageSrc("images/screenshot.png")).toBe("/docs-media/screenshot.png");
  });

  it("带 ./ 前缀同样处理", () => {
    expect(rewriteDocImageSrc("./images/screenshot.png")).toBe("/docs-media/screenshot.png");
  });

  it("外链图片原样返回", () => {
    expect(rewriteDocImageSrc("https://example.com/a.png")).toBe("https://example.com/a.png");
  });

  it("不在 images/ 下的相对路径原样返回", () => {
    expect(rewriteDocImageSrc("assets/a.png")).toBe("assets/a.png");
  });
});
