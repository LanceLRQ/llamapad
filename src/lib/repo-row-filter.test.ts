import { describe, expect, it } from "vitest";
import { visibleRepoRowIndices } from "./repo-row-filter";
describe("visibleRepoRowIndices", () => {
  const rows = [
    { files: ["qwen-IQ4_XS.gguf"] },
    { files: ["Q4_K_M/qwen.gguf"] },
    { files: ["qwen-lora-Q4.gguf"] },
    { files: ["gemma-lora.gguf"] },
    { files: ["qwen-mmproj.gguf"] },
    { files: ["mtp/qwen.gguf"] },
    { files: ["Q4_K_M/qwen-00001-of-00002.gguf", "Q4_K_M/qwen-00002-of-00002.gguf"] },
  ];

  it("多个标签取并集，再按关键字筛选，匹配多个标签的条目只出现一次", () => {
    expect([...visibleRepoRowIndices({ rows, tags: ["Q4", "lora"], query: " QWEN " })])
      .toEqual([0, 1, 2, 6]);
  });

  it("按仓库完整路径区分同名文件", () => {
    expect([...visibleRepoRowIndices({ rows, tags: ["MtP"], query: "qwen.gguf" })])
      .toEqual([5]);
  });

  it("空标签允许搜索任一片，返回整套分片所在的行", () => {
    expect([...visibleRepoRowIndices({ rows, tags: [], query: "00002-of-00002" })])
      .toEqual([6]);
  });

  it("空标签和空关键词显示所有文件", () => {
    expect([...visibleRepoRowIndices({ rows, tags: [], query: "" })])
      .toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});
