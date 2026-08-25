import { describe, expect, it } from "vitest";

import { countMatches, escapeRegExp, filterEntries, type FilterableLogEntry } from "./log-filter";

function entry(key: number, kind: FilterableLogEntry["kind"], text: string): FilterableLogEntry {
  return { key, kind, text };
}

describe("log-filter（UX P0 Task 4）", () => {
  const entries = [
    entry(1, "log", "llama_model_loader: loading model part 1/2"),
    entry(2, "container", "── 容器 llama-a ──"),
    entry(3, "log", "main: server is ready"),
    entry(4, "waiting", "· 等待容器…"),
    entry(5, "log", "ERROR: failed to bind port"),
  ];

  it("大小写不敏感子串过滤 log 行", () => {
    const hits = filterEntries(entries, "error");
    expect(hits.map((e) => e.key)).toEqual([2, 4, 5]);
  });

  it("元事件行（container/waiting）无论命中与否都保留", () => {
    const hits = filterEntries(entries, "llama_model_loader");
    expect(hits.map((e) => e.key)).toEqual([1, 2, 4]);
  });

  it("空白查询不过滤，原引用返回", () => {
    expect(filterEntries(entries, "   ")).toBe(entries);
    expect(filterEntries(entries, "")).toBe(entries);
  });

  it("countMatches 只数 log 行命中", () => {
    expect(countMatches(entries, "ERROR")).toBe(1);
    expect(countMatches(entries, "llama")).toBe(1); // 元事件行不计
    expect(countMatches(entries, "")).toBe(0);
  });

  it("escapeRegExp：正则元字符按字面量匹配", () => {
    expect(filterEntries([entry(1, "log", "a.b.c")], ".")).toHaveLength(1);
    expect(filterEntries([entry(1, "log", "abc")], ".")).toHaveLength(0);
    expect(escapeRegExp("a+b(c)")).toBe("a\\+b\\(c\\)");
  });
});
