import { describe, expect, it } from "vitest";
import { annotatedFileMetaPaths, deriveUnclaimed, sharedInodePaths } from "./unclaimed-view";

const tree = [
  { folder: "hf/o/R", files: [{ rel: "hf/o/R/a.gguf", size: 100, mtime: 0, ino: 1 }] },
  { folder: "loose", files: [
    { rel: "loose/b.gguf", size: 200, mtime: 0, ino: 2 },
    { rel: "loose/linked.gguf", size: 100, mtime: 0, ino: 1 },
  ] },
];

describe("deriveUnclaimed", () => {
  it("被引用的文件不算游离", () => {
    const got = deriveUnclaimed(tree, new Set(["loose/b.gguf"]), ["hf/o/R"], new Set());
    expect(got.map((f) => f.rel)).toEqual(["hf/o/R/a.gguf", "loose/linked.gguf"]);
  });

  it("标出所属档案目录", () => {
    const got = deriveUnclaimed(tree, new Set(), ["hf/o/R"], new Set());
    expect(got.find((f) => f.rel === "hf/o/R/a.gguf")!.inRepoDir).toBe("hf/o/R");
    expect(got.find((f) => f.rel === "loose/b.gguf")!.inRepoDir).toBeNull();
  });

  it("同 inode 的文件互相标为共用", () => {
    const got = deriveUnclaimed(tree, new Set(), ["hf/o/R"], new Set());
    expect(got.find((f) => f.rel === "loose/linked.gguf")!.sharedWith).toEqual(["hf/o/R/a.gguf"]);
  });

  it("annotatedPaths 命中的路径标 hasMeta（deriveUnclaimed 只负责按集合查，不关心集合是怎么算出来的）", () => {
    const got = deriveUnclaimed(tree, new Set(), ["hf/o/R"], new Set(["loose/b.gguf"]));
    expect(got.find((f) => f.rel === "loose/b.gguf")!.hasMeta).toBe(true);
    expect(got.find((f) => f.rel === "hf/o/R/a.gguf")!.hasMeta).toBe(false);
  });

  it("非 .gguf 文件不进清单——游离视图只关心权重", () => {
    const withReadme = [{ folder: "loose", files: [{ rel: "loose/README.md", size: 10, mtime: 0, ino: 9 }] }];
    expect(deriveUnclaimed(withReadme, new Set(), [], new Set())).toEqual([]);
  });
});

describe("annotatedFileMetaPaths", () => {
  it("quant_label 非空的行进结果集", () => {
    const got = annotatedFileMetaPaths([{ path: "a.gguf", quantLabel: "Q4_K_M", mark: null }]);
    expect(got.has("a.gguf")).toBe(true);
  });

  it("mark 非空的行进结果集（两个字段任一非空即算「有标注」）", () => {
    const got = annotatedFileMetaPaths([{ path: "a.gguf", quantLabel: null, mark: "备注" }]);
    expect(got.has("a.gguf")).toBe(true);
  });

  it("quant_label 与 mark 都为 null 的行不进结果集（任务 18 复核修的 bug：file_meta 单纯有一行——登记时机自动写入的空壳行——不等于用户标注过）", () => {
    const got = annotatedFileMetaPaths([{ path: "a.gguf", quantLabel: null, mark: null }]);
    expect(got.has("a.gguf")).toBe(false);
  });
});

describe("sharedInodePaths", () => {
  it("返回与目标文件同 inode 的其余路径", () => {
    expect(sharedInodePaths(tree, "loose/linked.gguf")).toEqual(["hf/o/R/a.gguf"]);
  });

  it("独占 inode 的文件返回空数组", () => {
    expect(sharedInodePaths(tree, "loose/b.gguf")).toEqual([]);
  });

  it("目标文件不在树里返回空数组", () => {
    expect(sharedInodePaths(tree, "does/not/exist.gguf")).toEqual([]);
  });

  it("已被引用的文件同样能查到共用同伴（不限于游离文件）", () => {
    expect(sharedInodePaths(tree, "hf/o/R/a.gguf")).toEqual(["loose/linked.gguf"]);
  });
});
