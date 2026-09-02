import { fromHtml } from "hast-util-from-html";
import { toHtml } from "hast-util-to-html";
import { sanitize } from "hast-util-sanitize";
import { describe, expect, it } from "vitest";

import { README_SANITIZE_SCHEMA } from "./markdown-sanitize";

// 跑真实的消毒管线（parse → sanitize → serialize），不只断言 schema 对象的字段——
// schema 是白名单的组合，只有跑一遍才能确认组合后的效果符合预期。
function clean(html: string): string {
  return toHtml(sanitize(fromHtml(html, { fragment: true }), README_SANITIZE_SCHEMA));
}

describe("README_SANITIZE_SCHEMA", () => {
  describe("必须被清除", () => {
    it("script 标签连同内容一起没了", () => {
      expect(clean("<script>alert(1)</script>")).not.toContain("alert");
    });

    it("img 的 onerror 事件处理器被剥掉，img 本身保留", () => {
      const out = clean('<img src=x onerror="alert(1)">');
      expect(out).toContain("<img");
      expect(out).not.toContain("onerror");
    });

    it("a 的 javascript: 协议 href 被剥掉", () => {
      expect(clean('<a href="javascript:alert(1)">x</a>')).not.toContain("javascript:");
    });

    it("javascript: 协议大小写混写同样被剥掉", () => {
      expect(clean('<a href="JavaScript:alert(1)">x</a>')).not.toContain("javascript:");
    });

    it("iframe 不被保留", () => {
      expect(clean('<iframe src="https://evil.com"></iframe>')).not.toContain("iframe");
    });

    it("svg 与其 onload 事件处理器都不被保留", () => {
      const out = clean('<svg onload="alert(1)"><circle /></svg>');
      expect(out).not.toContain("svg");
      expect(out).not.toContain("onload");
    });

    it("form 与其中的 password 输入框都不被保留", () => {
      const out = clean('<form action="https://evil.com"><input name="pw" type="password"></form>');
      expect(out).not.toContain("<form");
      expect(out).not.toContain("password");
    });

    it("div 保留，但 style 属性一律剥掉（视觉欺骗的主要载体）", () => {
      const out = clean('<div style="position:fixed;inset:0;z-index:9999">x</div>');
      expect(out).toContain("<div");
      expect(out).not.toContain("style");
    });

    it("p 保留，style 依旧被剥掉——单独钉一次：style 是全剥，不是部分放行", () => {
      const out = clean('<p style="color:#fff">x</p>');
      expect(out).toContain("<p");
      expect(out).not.toContain("style");
    });

    it("link 与 meta 都不被保留", () => {
      const out = clean('<link rel="stylesheet" href="https://evil.com/x.css"><meta http-equiv="refresh" content="0">');
      expect(out).not.toContain("<link");
      expect(out).not.toContain("<meta");
    });
  });

  describe("必须被保留", () => {
    it("普通嵌套标签原样保留", () => {
      const out = clean("<div><p><em>x</em></p></div>");
      expect(out).toContain("<div");
      expect(out).toContain("<p");
      expect(out).toContain("<em");
    });

    it("img 的 src / width / alt 都保留（width 是属性不是 style，unsloth 横幅靠它定形）", () => {
      const out = clean('<img src="https://example.com/a.png" width="133" alt="logo">');
      expect(out).toContain('src="https://example.com/a.png"');
      expect(out).toContain('width="133"');
      expect(out).toContain('alt="logo"');
    });

    it("a 的 https href 保留", () => {
      expect(clean('<a href="https://example.com">x</a>')).toContain('href="https://example.com"');
    });

    it("details/summary 都保留", () => {
      const out = clean("<details><summary>出处</summary>正文</details>");
      expect(out).toContain("<details");
      expect(out).toContain("<summary");
    });

    it("table 的 align 属性保留", () => {
      const out = clean("<table><tr><td align=\"center\">x</td></tr></table>");
      expect(out).toContain('align="center"');
    });

    it("code 的 language-* class 保留（代码高亮依赖它，剥掉高亮就没了）", () => {
      const out = clean('<code class="language-bash">x</code>');
      expect(out).toContain('class="language-bash"');
    });
  });
});
