import { describe, expect, it } from "vitest";
import { defaultTargetDir } from "./targetDir";

describe("defaultTargetDir", () => {
  it("取 gguf_file 最后一个 / 之前的完整目录路径", () => {
    expect(defaultTargetDir("qwen3.6/model.gguf")).toBe("qwen3.6");
    expect(defaultTargetDir("main/Qwen3-8B-Q4_K_M.gguf")).toBe("main");
  });

  it("无目录段（直接挂 models 根）返回空串，而不是拼出前导 / 或 .", () => {
    expect(defaultTargetDir("model.gguf")).toBe("");
  });

  it("gguf_file 是 glob 时同样安全：星号落在文件名段不影响判定", () => {
    expect(defaultTargetDir("qwen3.6/model-*.gguf")).toBe("qwen3.6");
  });

  it("多级目录取完整目录路径（阶段 3a：由只取第一段改为取到最后一段）", () => {
    expect(defaultTargetDir("a/b/model.gguf")).toBe("a/b");
    expect(defaultTargetDir("a/b/c/model-*.gguf")).toBe("a/b/c");
  });
});
