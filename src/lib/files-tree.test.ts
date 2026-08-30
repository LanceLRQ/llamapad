import { describe, expect, it } from "vitest";

import { breadcrumbSegments, childFolders, folderOfRel, sortFolderRows, type FolderTreeEntry } from "./files-tree";

describe("breadcrumbSegments", () => {
  it("根目录（空串）没有分段", () => {
    expect(breadcrumbSegments("")).toEqual([]);
  });

  it("一级目录只有一段", () => {
    expect(breadcrumbSegments("main")).toEqual([{ name: "main", path: "main" }]);
  });

  it("多级目录逐段累积路径", () => {
    expect(breadcrumbSegments("qwen3.6/70b")).toEqual([
      { name: "qwen3.6", path: "qwen3.6" },
      { name: "70b", path: "qwen3.6/70b" },
    ]);
  });

  it("三级以上同样逐段累积，不是只取首尾两段", () => {
    expect(breadcrumbSegments("a/b/c")).toEqual([
      { name: "a", path: "a" },
      { name: "b", path: "a/b" },
      { name: "c", path: "a/b/c" },
    ]);
  });
});

describe("childFolders", () => {
  const f = (size: number) => ({ size });

  it("根目录聚合出一级目录清单，不含根自己（folder: \"\"）", () => {
    const tree: FolderTreeEntry[] = [
      { folder: "", files: [f(10)] }, // 根下散落文件，不是"根的子目录"
      { folder: "main", files: [f(100), f(200)] },
      { folder: "vision", files: [f(50)] },
    ];
    expect(childFolders(tree, "")).toEqual([
      { name: "main", path: "main", fileCount: 2, bytes: 300 },
      { name: "vision", path: "vision", fileCount: 1, bytes: 50 },
    ]);
  });

  it("一级目录的递归总数含全部更深层子目录，即使自己没有直接文件", () => {
    const tree: FolderTreeEntry[] = [
      { folder: "qwen3.6", files: [] }, // 自己空手，但子目录里有一堆文件
      { folder: "qwen3.6/70b", files: [f(100)] },
      { folder: "qwen3.6/70b/split", files: [f(50), f(50)] },
    ];
    // 左侧二级栏看到的是 qwen3.6 这一级目录：3 个文件、200 字节，
    // 而不是「0 个文件」——这正是 C3 要修的用户困惑
    expect(childFolders(tree, "")).toEqual([
      { name: "qwen3.6", path: "qwen3.6", fileCount: 3, bytes: 200 },
    ]);
  });

  it("给定任意深度的 current，返回它的直接子目录（C4 下钻一层）", () => {
    const tree: FolderTreeEntry[] = [
      { folder: "qwen3.6", files: [f(1)] },
      { folder: "qwen3.6/70b", files: [f(100)] },
      { folder: "qwen3.6/70b/split", files: [f(50), f(50)] },
      { folder: "qwen3.6/8b", files: [f(10)] },
    ];
    expect(childFolders(tree, "qwen3.6")).toEqual([
      { name: "70b", path: "qwen3.6/70b", fileCount: 3, bytes: 200 },
      { name: "8b", path: "qwen3.6/8b", fileCount: 1, bytes: 10 },
    ]);
  });

  it("current 自身的直接文件不算进子目录聚合（那是调用方另取的当前目录切片）", () => {
    const tree: FolderTreeEntry[] = [{ folder: "main", files: [f(1), f(2)] }];
    expect(childFolders(tree, "main")).toEqual([]);
  });

  it("没有子目录时返回空数组", () => {
    expect(childFolders([{ folder: "main", files: [f(1)] }], "main")).toEqual([]);
  });

  it("结果按名字升序排列", () => {
    const tree: FolderTreeEntry[] = [
      { folder: "zeta", files: [] },
      { folder: "alpha", files: [] },
    ];
    expect(childFolders(tree, "").map((r) => r.name)).toEqual(["alpha", "zeta"]);
  });
});

describe("sortFolderRows", () => {
  const rows = [
    { name: "b", path: "b", fileCount: 1, bytes: 200 },
    { name: "a", path: "a", fileCount: 5, bytes: 100 },
  ];

  it("按名字升序/降序", () => {
    expect(sortFolderRows(rows, "name", "asc").map((r) => r.name)).toEqual(["a", "b"]);
    expect(sortFolderRows(rows, "name", "desc").map((r) => r.name)).toEqual(["b", "a"]);
  });

  it("按占用大小升序/降序", () => {
    expect(sortFolderRows(rows, "size", "asc").map((r) => r.name)).toEqual(["a", "b"]);
    expect(sortFolderRows(rows, "size", "desc").map((r) => r.name)).toEqual(["b", "a"]);
  });

  it("按修改时间排序时退化为按名字排序（目录没有单一的修改时间）", () => {
    expect(sortFolderRows(rows, "mtime", "asc").map((r) => r.name)).toEqual(["a", "b"]);
  });

  it("不修改入参数组", () => {
    const copy = [...rows];
    sortFolderRows(rows, "name", "desc");
    expect(rows).toEqual(copy);
  });
});

describe("folderOfRel", () => {
  it("一级目录下的文件返回该目录", () => {
    expect(folderOfRel("main/a.gguf")).toBe("main");
  });

  it("多级目录取完整路径而非首段（移动候选过滤的回归锁）", () => {
    expect(folderOfRel("qwen3.6/70b/m-00001.gguf")).toBe("qwen3.6/70b");
    expect(folderOfRel("a/b/c/d.gguf")).toBe("a/b/c");
  });

  it("根下散落文件返回空串", () => {
    expect(folderOfRel("root-loose.gguf")).toBe("");
  });
});
