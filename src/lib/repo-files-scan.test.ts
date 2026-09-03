import { describe, expect, it } from "vitest";
import { PART_META_SUFFIX, PART_SUFFIX } from "./download-part";
import { scanRepoFiles, type ScanNode } from "./repo-files-scan";

/**
 * scanRepoFiles 测试（批 A 任务，I3/I5 回归锁）。
 *
 * tree 的形状与 server/fsScanner.ts 的 scanTree 返回值结构性兼容
 * （ScanNode 是它的子集类型），这里直接手搭 fixture，不依赖真实文件系统。
 */

describe("scanRepoFiles", () => {
  it("本档案目录内的文件进 local，目录外的进 strays", () => {
    const tree: ScanNode[] = [
      { folder: "hf/o/r", files: [{ rel: "hf/o/r/Q4_K_M.gguf", size: 100 }] },
      { folder: "main", files: [{ rel: "main/other.gguf", size: 50 }] },
    ];
    const result = scanRepoFiles(tree, "hf/o/r", ["hf/o/r"]);
    expect(result.local).toEqual([{ rel: "hf/o/r/Q4_K_M.gguf", size: 100, sharedWith: [] }]);
    expect(result.strays).toEqual([{ file: "other.gguf", rel: "main/other.gguf", size: 50, inRepoDir: null }]);
  });

  it("档案目录的子目录内文件也算 local", () => {
    const tree: ScanNode[] = [
      { folder: "hf/o/r", files: [] },
      { folder: "hf/o/r/sub", files: [{ rel: "hf/o/r/sub/part2.gguf", size: 10 }] },
    ];
    const result = scanRepoFiles(tree, "hf/o/r", ["hf/o/r"]);
    expect(result.local).toEqual([{ rel: "hf/o/r/sub/part2.gguf", size: 10, sharedWith: [] }]);
  });

  // I3 已由本批（任务 11）超越：别的档案目录不再整体排除。这条锁的是一个
  // 更窄但仍然成立的场景——这里恰好与本档案目录内的文件同名，靠 localNames
  // 去重排除，不是靠目录排除；见下方「本档案目录内已有同名文件……」那条
  // 才是真正在验证 dedup 本身
  it("别的档案目录里的文件与本档案已有文件同名时，仍按 dedup 规则不算 stray", () => {
    const tree: ScanNode[] = [
      { folder: "hf/o/r", files: [{ rel: "hf/o/r/Q4_K_M.gguf", size: 100 }] },
      { folder: "hf/other/r2", files: [{ rel: "hf/other/r2/Q4_K_M.gguf", size: 100 }] },
    ];
    const result = scanRepoFiles(tree, "hf/o/r", ["hf/o/r", "hf/other/r2"]);
    expect(result.local).toEqual([{ rel: "hf/o/r/Q4_K_M.gguf", size: 100, sharedWith: [] }]);
    expect(result.strays).toEqual([]);
  });

  it(".part 与 .part.meta.json 两类半成品都被滤掉，local 与 strays 都不含它们", () => {
    const tree: ScanNode[] = [
      {
        folder: "hf/o/r",
        files: [
          { rel: "hf/o/r/Q4_K_M.gguf", size: 100 },
          { rel: `hf/o/r/X-Q4_K_M.gguf${PART_SUFFIX}`, size: 30 },
          { rel: `hf/o/r/X-Q4_K_M.gguf${PART_META_SUFFIX}`, size: 1 },
        ],
      },
      {
        folder: "main",
        files: [
          { rel: "main/other.gguf", size: 50 },
          { rel: `main/other.gguf${PART_SUFFIX}`, size: 20 },
          { rel: `main/other.gguf${PART_META_SUFFIX}`, size: 1 },
        ],
      },
    ];
    const result = scanRepoFiles(tree, "hf/o/r", ["hf/o/r"]);
    expect(result.local).toEqual([{ rel: "hf/o/r/Q4_K_M.gguf", size: 100, sharedWith: [] }]);
    expect(result.strays).toEqual([{ file: "other.gguf", rel: "main/other.gguf", size: 50, inRepoDir: null }]);
  });

  it("strays 条目带 size", () => {
    const tree: ScanNode[] = [
      { folder: "hf/o/r", files: [] },
      { folder: "main", files: [{ rel: "main/other.gguf", size: 123 }] },
    ];
    const result = scanRepoFiles(tree, "hf/o/r", ["hf/o/r"]);
    expect(result.strays[0]?.size).toBe(123);
  });

  it("本档案目录内已有同名文件时，全盘其他位置的同名文件不算 stray", () => {
    const tree: ScanNode[] = [
      { folder: "hf/o/r", files: [{ rel: "hf/o/r/Q4_K_M.gguf", size: 100 }] },
      { folder: "main", files: [{ rel: "main/Q4_K_M.gguf", size: 100 }] },
    ];
    const result = scanRepoFiles(tree, "hf/o/r", ["hf/o/r"]);
    expect(result.strays).toEqual([]);
  });

  it("在别的档案目录内的文件也算候选，并标出所属档案", () => {
    const tree = [
      { folder: "hf/other/Repo", files: [{ rel: "hf/other/Repo/m.gguf", size: 100 }] },
    ];
    const got = scanRepoFiles(tree, "hf/mine/Repo", ["hf/mine/Repo", "hf/other/Repo"]);
    expect(got.strays).toEqual([
      { file: "m.gguf", rel: "hf/other/Repo/m.gguf", size: 100, inRepoDir: "hf/other/Repo" },
    ]);
  });

  it("本档案目录内的文件不算 stray（它已经在位）", () => {
    const tree = [{ folder: "hf/mine/Repo", files: [{ rel: "hf/mine/Repo/m.gguf", size: 100 }] }];
    expect(scanRepoFiles(tree, "hf/mine/Repo", ["hf/mine/Repo"]).strays).toEqual([]);
  });

  // 本地权重迁移批③任务 15：sharedWith 是硬链接共用标注的数据来源
  it("本档案目录内的文件与别的档案目录内的文件同 ino 时，互相记进 sharedWith", () => {
    const tree: ScanNode[] = [
      { folder: "hf/mine/Repo", files: [{ rel: "hf/mine/Repo/m.gguf", size: 100, ino: 7 }] },
      { folder: "hf/other/Repo", files: [{ rel: "hf/other/Repo/m.gguf", size: 100, ino: 7 }] },
    ];
    const result = scanRepoFiles(tree, "hf/mine/Repo", ["hf/mine/Repo", "hf/other/Repo"]);
    expect(result.local).toEqual([
      { rel: "hf/mine/Repo/m.gguf", size: 100, sharedWith: ["hf/other/Repo/m.gguf"] },
    ]);
  });

  it("ino 不同（哪怕同名同大小）不算共用", () => {
    const tree: ScanNode[] = [
      { folder: "hf/mine/Repo", files: [{ rel: "hf/mine/Repo/m.gguf", size: 100, ino: 7 }] },
      { folder: "hf/other/Repo", files: [{ rel: "hf/other/Repo/m.gguf", size: 100, ino: 8 }] },
    ];
    const result = scanRepoFiles(tree, "hf/mine/Repo", ["hf/mine/Repo", "hf/other/Repo"]);
    expect(result.local[0]?.sharedWith).toEqual([]);
  });

  it("三个路径共用同一 ino 时，sharedWith 列出另外两个，不含自身", () => {
    const tree: ScanNode[] = [
      {
        folder: "hf/mine/Repo",
        files: [{ rel: "hf/mine/Repo/m.gguf", size: 100, ino: 7 }],
      },
      {
        folder: "hf/other/Repo",
        files: [{ rel: "hf/other/Repo/m.gguf", size: 100, ino: 7 }],
      },
      { folder: "loose", files: [{ rel: "loose/m.gguf", size: 100, ino: 7 }] },
    ];
    const result = scanRepoFiles(tree, "hf/mine/Repo", ["hf/mine/Repo", "hf/other/Repo"]);
    expect(result.local[0]?.sharedWith).toEqual(["hf/other/Repo/m.gguf", "loose/m.gguf"]);
  });

  it("没有 ino 信息的夹具（旧测试的既有写法）sharedWith 恒为空数组", () => {
    const tree: ScanNode[] = [{ folder: "hf/o/r", files: [{ rel: "hf/o/r/Q4_K_M.gguf", size: 100 }] }];
    expect(scanRepoFiles(tree, "hf/o/r", ["hf/o/r"]).local[0]?.sharedWith).toEqual([]);
  });
});
