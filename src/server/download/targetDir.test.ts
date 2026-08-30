import { describe, expect, it } from "vitest";
import { defaultTargetDir } from "./targetDir";

describe("defaultTargetDir", () => {
  it("取 gguf_file 第一个 / 之前的目录段", () => {
    expect(defaultTargetDir("qwen3.6/model.gguf")).toBe("qwen3.6");
    expect(defaultTargetDir("main/Qwen3-8B-Q4_K_M.gguf")).toBe("main");
  });

  it("无目录段（直接挂 models 根）返回空串，而不是拼出前导 / 或 .", () => {
    expect(defaultTargetDir("model.gguf")).toBe("");
  });

  it("gguf_file 是 glob 时同样安全：只看第一段，星号落在文件名段不影响判定", () => {
    expect(defaultTargetDir("qwen3.6/model-*.gguf")).toBe("qwen3.6");
  });

  it("多级目录只取第一段（现状不支持多级 models 目录，见 manager.ts 顶部注释）", () => {
    expect(defaultTargetDir("a/b/model.gguf")).toBe("a");
  });
});
