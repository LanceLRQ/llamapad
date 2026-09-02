import { describe, expect, it } from "vitest";

import { suggestedPresetName } from "./suggested-preset-name";

describe("suggestedPresetName", () => {
  it("拼接仓库基名与 label，转小写连字符", () => {
    expect(suggestedPresetName("Qwen3.8-27B-GGUF", "Thinking")).toBe("qwen3-8-27b-gguf-thinking");
  });

  it("label 为空串时落到 official", () => {
    expect(suggestedPresetName("Qwen3.8-27B-GGUF", "")).toBe("qwen3-8-27b-gguf-official");
  });

  it("label 是纯空白字符串同样落到 official", () => {
    expect(suggestedPresetName("repo", "   ")).toBe("repo-official");
  });

  it("非字母数字连续段折成单个连字符，且去首尾连字符", () => {
    expect(suggestedPresetName("Hauhau CS_Repo!!", "Aggressive MTP")).toBe("hauhau-cs-repo-aggressive-mtp");
  });
});
