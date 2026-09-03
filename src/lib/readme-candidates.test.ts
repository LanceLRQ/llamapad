import { describe, expect, it } from "vitest";

import { readmeCandidates } from "./readme-candidates";

describe("readmeCandidates", () => {
  it("含参数关键词的段落优先于不含的", () => {
    const body = [
      "This model is a fine-tune of something.",
      "Set the temperature to 0.6 and top_p to 0.95.",
    ].join("\n\n");

    const out = readmeCandidates(body, 60);
    expect(out.text).toContain("temperature");
    expect(out.text).not.toContain("fine-tune");
  });

  it("预算够时全部保留，并按原文顺序拼回", () => {
    const body = ["Set temperature 0.6.", "Intro paragraph.", "Use top_p 0.95."].join("\n\n");
    const out = readmeCandidates(body, 10_000);

    expect(out.truncated).toBe(false);
    expect(out.text.indexOf("temperature")).toBeLessThan(out.text.indexOf("top_p"));
    expect(out.text.indexOf("Intro")).toBeGreaterThan(out.text.indexOf("temperature"));
  });

  it("超预算时截断并标记", () => {
    const body = Array.from({ length: 50 }, (_, i) => `Paragraph ${i} with temperature 0.${i}.`).join("\n\n");
    const out = readmeCandidates(body, 200);

    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(200);
  });

  it("中文关键词同样计分", () => {
    const body = ["这是一段介绍文字。", "推荐参数：温度 0.6，top_p 0.95。"].join("\n\n");
    const out = readmeCandidates(body, 60);
    expect(out.text).toContain("推荐参数");
  });

  it("代码块整块参与，不被段落切分打散", () => {
    const body = ["Intro.", "```bash\nllama-server --temp 0.6 \\\n  --top-p 0.95\n```"].join("\n\n");
    const out = readmeCandidates(body, 200);
    expect(out.text).toContain("--temp 0.6");
    expect(out.text).toContain("--top-p 0.95");
  });

  it("空输入产出空结果，不抛错", () => {
    expect(readmeCandidates("", 100)).toEqual({ text: "", truncated: false });
  });

  it("全是无关内容时也回一段（让模型自己判断没有，而不是面板替它判断）", () => {
    const out = readmeCandidates("Just a plain description of the model.", 500);
    expect(out.text).not.toBe("");
  });

  // 兜底分支：单段落就超预算。返回空片段等于放弃整个功能——
  // 模型收到空文本只能瞎编，而这个功能存在的全部意义就是别让它瞎编
  it("单段落就超预算时截到 budget，绝不返回空片段", () => {
    const body = `temperature ${"x".repeat(500)}`;
    const out = readmeCandidates(body, 100);
    expect(out.text.length).toBe(100);
    expect(out.text.startsWith("temperature")).toBe(true);
    expect(out.truncated).toBe(true);
  });
});
