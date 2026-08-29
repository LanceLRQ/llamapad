import { describe, expect, it } from "vitest";

import { applyFileMetaQuery, type FileMetaQuery } from "./file-meta-list";

interface Row {
  path: string;
  size: number | null;
}

const rows: Row[] = [
  { path: "main/Qwen2.5-7B-Instruct-Q4_K_M.gguf", size: 4_700_000_000 },
  { path: "embedding/bge-m3-Q8_0.gguf", size: 685_700_000 },
  { path: "main/Mistral-7B-Instruct-v0.3-Q5_K_M.gguf", size: null }, // 孤儿记录
  { path: "vision/Qwen2-VL-7B-Instruct-mmproj-F16.gguf", size: 1_400_000_000 },
];

describe("applyFileMetaQuery", () => {
  it("关键字匹配完整 path（含命名空间前缀），大小写不敏感", () => {
    const query: FileMetaQuery = { keyword: "EMBEDDING/BGE", sort: "name", dir: "asc" };
    const result = applyFileMetaQuery(rows, query);
    expect(result.map((r) => r.path)).toEqual(["embedding/bge-m3-Q8_0.gguf"]);
  });

  it("按大小排序时孤儿记录（size=null）恒排末尾，不论升降序", () => {
    const asc = applyFileMetaQuery(rows, { keyword: "", sort: "size", dir: "asc" });
    const desc = applyFileMetaQuery(rows, { keyword: "", sort: "size", dir: "desc" });
    expect(asc.at(-1)?.size).toBeNull();
    expect(desc.at(-1)?.size).toBeNull();
  });

  it("按名称排序时孤儿记录留在字母序本来的位置，不垫底", () => {
    const result = applyFileMetaQuery(rows, { keyword: "", sort: "name", dir: "asc" });
    expect(result.map((r) => r.path)).toEqual([
      "embedding/bge-m3-Q8_0.gguf",
      "main/Mistral-7B-Instruct-v0.3-Q5_K_M.gguf",
      "main/Qwen2.5-7B-Instruct-Q4_K_M.gguf",
      "vision/Qwen2-VL-7B-Instruct-mmproj-F16.gguf",
    ]);
    // 孤儿记录排在字母序第二位，不是排最后——按名称排序不该把它踢到表尾
    expect(result[1].size).toBeNull();
  });

  it("不修改入参数组", () => {
    const snapshot = [...rows];
    applyFileMetaQuery(rows, { keyword: "", sort: "size", dir: "desc" });
    expect(rows).toEqual(snapshot);
  });
});
