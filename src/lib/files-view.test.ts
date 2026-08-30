import { describe, expect, it } from "vitest";

import { FILES_VIEW_ALL_KEY, FILES_VIEW_META_KEY, resolveFilesQuery, resolveFilesView } from "./files-view";

describe("resolveFilesView", () => {
  const folders = ["embedding", "main", "vision"];

  it("raw 为 undefined 时落到 all 视图", () => {
    expect(resolveFilesView(undefined, folders)).toEqual({ kind: "all" });
  });

  it("raw 字面量 all 落到 all 视图", () => {
    expect(resolveFilesView(FILES_VIEW_ALL_KEY, folders)).toEqual({ kind: "all" });
  });

  it("raw 命中真实文件夹时落到 folder 视图", () => {
    expect(resolveFilesView("main", folders)).toEqual({ kind: "folder", folder: "main" });
  });

  it("raw 为 @meta 时落到 meta 视图", () => {
    expect(resolveFilesView(FILES_VIEW_META_KEY, folders)).toEqual({ kind: "meta" });
  });

  it("拼错的/已删除的文件夹名落到 all 视图", () => {
    expect(resolveFilesView("does-not-exist", folders)).toEqual({ kind: "all" });
  });

  it("文件夹恰好叫 all 时优先命中文件夹分支，而非 all 键", () => {
    expect(resolveFilesView("all", ["all", "main"])).toEqual({ kind: "folder", folder: "all" });
  });

  it("文件夹恰好叫 meta 时，@meta 仍落到 meta 视图（@ 是磁盘目录名里几乎不会出现的字符，见下方注释）", () => {
    expect(resolveFilesView(FILES_VIEW_META_KEY, ["meta", "main"])).toEqual({ kind: "meta" });
    // 而文件夹本身叫 "meta"（合法磁盘目录名，不含 @）时，走的是普通文件夹分支
    expect(resolveFilesView("meta", ["meta", "main"])).toEqual({ kind: "folder", folder: "meta" });
  });
});

describe("resolveFilesQuery", () => {
  it("新键 path 有值时优先于旧键 ns", () => {
    expect(resolveFilesQuery("main", "old-bookmark")).toBe("main");
  });

  it("path 缺失时兜底到旧键 ns（旧书签仍可用）", () => {
    expect(resolveFilesQuery(undefined, "main")).toBe("main");
  });

  it("两者都缺失时返回 undefined（落到 resolveFilesView 的 all 兜底）", () => {
    expect(resolveFilesQuery(undefined, undefined)).toBeUndefined();
  });
});
