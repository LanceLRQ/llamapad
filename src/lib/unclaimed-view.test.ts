import { describe, expect, it } from "vitest";
import { deriveUnclaimed } from "./unclaimed-view";

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

  it("有 file_meta 记录的标 hasMeta", () => {
    const got = deriveUnclaimed(tree, new Set(), ["hf/o/R"], new Set(["loose/b.gguf"]));
    expect(got.find((f) => f.rel === "loose/b.gguf")!.hasMeta).toBe(true);
  });

  it("非 .gguf 文件不进清单——游离视图只关心权重", () => {
    const withReadme = [{ folder: "loose", files: [{ rel: "loose/README.md", size: 10, mtime: 0, ino: 9 }] }];
    expect(deriveUnclaimed(withReadme, new Set(), [], new Set())).toEqual([]);
  });
});
