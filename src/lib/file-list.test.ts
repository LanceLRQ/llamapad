import { describe, expect, it } from "vitest";
import { applyFileQuery, type FileQuery } from "./file-list";

const files = [
  { rel: "main/qwen3-30b-Q4_K_M.gguf", size: 18_000, mtime: 300, refs: 1 },
  { rel: "main/gemma-27b-Q5_K_M.gguf", size: 22_000, mtime: 100, refs: 0 },
  { rel: "main/mmproj-qwen.gguf", size: 800, mtime: 200, refs: 1 },
];
const q = (over: Partial<FileQuery> = {}): FileQuery => ({ keyword: "", sort: "name", dir: "asc", ...over });

describe("applyFileQuery", () => {
  it("默认按名称升序", () => {
    expect(applyFileQuery(files, q()).map((f) => f.rel)).toEqual([
      "main/gemma-27b-Q5_K_M.gguf", "main/mmproj-qwen.gguf", "main/qwen3-30b-Q4_K_M.gguf",
    ]);
  });
  it("按大小降序", () => {
    expect(applyFileQuery(files, q({ sort: "size", dir: "desc" }))[0].size).toBe(22_000);
  });
  it("按时间降序", () => {
    expect(applyFileQuery(files, q({ sort: "mtime", dir: "desc" }))[0].mtime).toBe(300);
  });
  it("关键字大小写不敏感匹配文件名", () => {
    expect(applyFileQuery(files, q({ keyword: "QWEN" })).map((f) => f.rel)).toEqual([
      "main/mmproj-qwen.gguf", "main/qwen3-30b-Q4_K_M.gguf",
    ]);
  });
  it("关键字无命中返回空数组", () => {
    expect(applyFileQuery(files, q({ keyword: "zzz" }))).toEqual([]);
  });
  it("不修改入参数组", () => {
    const copy = [...files];
    applyFileQuery(files, q({ sort: "size" }));
    expect(files).toEqual(copy);
  });
});
