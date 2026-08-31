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
    expect(result.local).toEqual([{ rel: "hf/o/r/Q4_K_M.gguf", size: 100 }]);
    expect(result.strays).toEqual([{ file: "other.gguf", rel: "main/other.gguf", size: 50 }]);
  });

  it("档案目录的子目录内文件也算 local", () => {
    const tree: ScanNode[] = [
      { folder: "hf/o/r", files: [] },
      { folder: "hf/o/r/sub", files: [{ rel: "hf/o/r/sub/part2.gguf", size: 10 }] },
    ];
    const result = scanRepoFiles(tree, "hf/o/r", ["hf/o/r"]);
    expect(result.local).toEqual([{ rel: "hf/o/r/sub/part2.gguf", size: 10 }]);
  });

  // I3 回归锁：别的档案目录里的同名文件既不进 local 也不进 strays，
  // 因为服务端 planFileMove 拒绝 from 落在任何档案目录内的请求，
  // UI 给出的「在别处」集合必须是服务端愿意接受的子集
  it("别的档案目录里的文件既不进 local 也不进 strays", () => {
    const tree: ScanNode[] = [
      { folder: "hf/o/r", files: [{ rel: "hf/o/r/Q4_K_M.gguf", size: 100 }] },
      { folder: "hf/other/r2", files: [{ rel: "hf/other/r2/Q4_K_M.gguf", size: 100 }] },
    ];
    const result = scanRepoFiles(tree, "hf/o/r", ["hf/o/r", "hf/other/r2"]);
    expect(result.local).toEqual([{ rel: "hf/o/r/Q4_K_M.gguf", size: 100 }]);
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
    expect(result.local).toEqual([{ rel: "hf/o/r/Q4_K_M.gguf", size: 100 }]);
    expect(result.strays).toEqual([{ file: "other.gguf", rel: "main/other.gguf", size: 50 }]);
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
});
