import { describe, expect, it } from "vitest";
import { filenameFromUrl } from "./download-url";

/**
 * M2 修复（TDD）：downloads/direct route 原地写的兜底逻辑有两个问题——
 * `.pop()` 在根路径下拿到 `""` 而非 `undefined`，`?? "download.gguf"` 是
 * 死分支；`decodeURIComponent` 不在 try 内，畸形转义直接抛成 500。
 * 判定下沉到这里统一验证。
 */
describe("filenameFromUrl", () => {
  it("正常路径取最后一段并解码", () => {
    expect(filenameFromUrl("https://example.com/models/foo.gguf")).toBe("foo.gguf");
  });

  it("以 / 结尾时取最后一个非空段", () => {
    expect(filenameFromUrl("https://example.com/models/foo.gguf/")).toBe("foo.gguf");
  });

  it("根路径回落 download.gguf", () => {
    expect(filenameFromUrl("https://x.com/")).toBe("download.gguf");
  });

  it("畸形百分号转义不抛异常，回落到原始段", () => {
    expect(() => filenameFromUrl("https://x.com/%E0%A4%A")).not.toThrow();
    expect(filenameFromUrl("https://x.com/%E0%A4%A")).toBe("%E0%A4%A");
  });

  it("已编码的中文文件名能正确解码", () => {
    expect(filenameFromUrl("https://example.com/%E6%A8%A1%E5%9E%8B.gguf")).toBe("模型.gguf");
  });
});
