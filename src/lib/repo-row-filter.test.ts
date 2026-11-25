import { describe, expect, it } from "vitest";
import type { RepoRow } from "./repo-files-view";
import { visibleRepoRowIndices } from "./repo-row-filter";
describe("visibleRepoRowIndices", () => {
  const rows: Pick<RepoRow, "files" | "state">[] = [
    { files: ["qwen-IQ4_XS.gguf"], state: "absent" },
    { files: ["Q4_K_M/qwen.gguf"], state: "present" },
    { files: ["qwen-lora-Q4.gguf"], state: "downloading" },
    { files: ["gemma-lora.gguf"], state: "present" },
    { files: ["qwen-mmproj.gguf"], state: "stray" },
    { files: ["mtp/qwen.gguf"], state: "present" },
    { files: ["Q4_K_M/qwen-00001-of-00002.gguf", "Q4_K_M/qwen-00002-of-00002.gguf"], state: "partial" },
  ];

  it("多个标签取并集，再按关键字筛选，匹配多个标签的条目只出现一次", () => {
    expect([...visibleRepoRowIndices({ rows, tags: ["Q4", "lora"], states: [], query: " QWEN " })])
      .toEqual([0, 1, 2, 6]);
  });

  it("按仓库完整路径区分同名文件", () => {
    expect([...visibleRepoRowIndices({ rows, tags: ["MtP"], states: [], query: "qwen.gguf" })])
      .toEqual([5]);
  });

  it("空标签允许搜索任一片，返回整套分片所在的行", () => {
    expect([...visibleRepoRowIndices({ rows, tags: [], states: [], query: "00002-of-00002" })])
      .toEqual([6]);
  });

  it("状态标签可独立多选", () => {
    expect([...visibleRepoRowIndices({ rows, tags: [], states: ["absent", "downloading", "stray"], query: "" })])
      .toEqual([0, 2, 4]);
  });

  it("状态标签与类型标签和关键词同时生效", () => {
    expect([...visibleRepoRowIndices({ rows, tags: ["Q4", "lora"], states: ["present", "partial"], query: "qwen" })])
      .toEqual([1, 6]);
  });

  it("空标签、空状态和空关键词显示所有文件", () => {
    expect([...visibleRepoRowIndices({ rows, tags: [], states: [], query: "" })])
      .toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});
