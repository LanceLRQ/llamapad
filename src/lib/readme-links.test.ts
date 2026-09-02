import { describe, expect, it } from "vitest";

import { resolveReadmeUrl } from "./readme-links";

const CTX = { repo: "unsloth/Qwen3.8-27B-GGUF", endpoint: "https://huggingface.co" } as const;

describe("resolveReadmeUrl", () => {
  it("相对图片走 resolve（要的是原始字节）", () => {
    expect(resolveReadmeUrl("images/demo.png", { ...CTX, kind: "image" })).toBe(
      "https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/main/images/demo.png",
    );
  });

  it("相对链接走 blob（要的是网页）", () => {
    expect(resolveReadmeUrl("docs/usage.md", { ...CTX, kind: "link" })).toBe(
      "https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/blob/main/docs/usage.md",
    );
  });

  it("./ 前缀会被规范化掉", () => {
    expect(resolveReadmeUrl("./a/b.png", { ...CTX, kind: "image" })).toBe(
      "https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/main/a/b.png",
    );
  });

  it("绝对 URL 原样返回", () => {
    const u = "https://cdn.example.com/x.png";
    expect(resolveReadmeUrl(u, { ...CTX, kind: "image" })).toBe(u);
  });

  it("data: URI 原样返回", () => {
    const u = "data:image/png;base64,AAAA";
    expect(resolveReadmeUrl(u, { ...CTX, kind: "image" })).toBe(u);
  });

  it("根相对路径挂到站点根，而不是留给面板（留着就是死链）", () => {
    expect(resolveReadmeUrl("/Qwen/Qwen3.8-27B", { ...CTX, kind: "link" })).toBe(
      "https://huggingface.co/Qwen/Qwen3.8-27B",
    );
  });

  it("纯锚点返回 null（面板内无对应目标，调用方据此去掉 href）", () => {
    expect(resolveReadmeUrl("#usage", { ...CTX, kind: "link" })).toBeNull();
  });

  it("空 href 返回 null", () => {
    expect(resolveReadmeUrl("", { ...CTX, kind: "link" })).toBeNull();
    expect(resolveReadmeUrl(undefined, { ...CTX, kind: "link" })).toBeNull();
  });

  it("镜像端点原样参与拼接", () => {
    expect(
      resolveReadmeUrl("a.png", { repo: "o/r", endpoint: "https://hf-mirror.com", kind: "image" }),
    ).toBe("https://hf-mirror.com/o/r/resolve/main/a.png");
  });

  it("端点尾部斜杠不会拼出双斜杠", () => {
    expect(
      resolveReadmeUrl("a.png", { repo: "o/r", endpoint: "https://hf-mirror.com/", kind: "image" }),
    ).toBe("https://hf-mirror.com/o/r/resolve/main/a.png");
  });
});
