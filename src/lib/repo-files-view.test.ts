import { describe, expect, it } from "vitest";
import { mergeRepoRows, type RepoRowInput } from "./repo-files-view";

const base: RepoRowInput = {
  groups: [
    { quant: "Q4_K_M", label: "Q4_K_M", kind: "model", files: [{ path: "Q4_K_M.gguf", size: 100 }], totalSize: 100, shards: 1, shardTotalDeclared: null },
  ],
  local: [],
  strays: [],
  tasks: [],
  configs: [],
  targetDir: "hf/o/r",
};

describe("mergeRepoRows", () => {
  it("本地没有该文件时状态为未下载", () => {
    expect(mergeRepoRows(base)[0].state).toBe("absent");
  });

  it("本地齐全时状态为已下载", () => {
    const rows = mergeRepoRows({ ...base, local: [{ rel: "hf/o/r/Q4_K_M.gguf", size: 100 }] });
    expect(rows[0].state).toBe("present");
  });

  it("有进行中任务时状态为下载中，优先于本地判定", () => {
    const rows = mergeRepoRows({
      ...base,
      local: [{ rel: "hf/o/r/Q4_K_M.gguf", size: 100 }],
      tasks: [{ file: "Q4_K_M.gguf", status: "downloading", downloadedBytes: 50 }],
    });
    expect(rows[0].state).toBe("downloading");
    expect(rows[0].progress).toBeCloseTo(0.5);
  });

  it("分片组只到齐一部分时状态为部分，并给出分片计数", () => {
    const rows = mergeRepoRows({
      ...base,
      groups: [{
        quant: "Q4_K_M", label: "Q4_K_M", kind: "model",
        files: [
          { path: "m-00001-of-00003.gguf", size: 10 },
          { path: "m-00002-of-00003.gguf", size: 10 },
          { path: "m-00003-of-00003.gguf", size: 10 },
        ],
        totalSize: 30, shards: 3, shardTotalDeclared: 3,
      }],
      local: [{ rel: "hf/o/r/m-00001-of-00003.gguf", size: 10 }],
    });
    expect(rows[0].state).toBe("partial");
    expect(rows[0].haveShards).toBe(1);
    expect(rows[0].totalShards).toBe(3);
  });

  it("文件不在档案目录但全盘有同名时状态为在别处，并带出实际路径", () => {
    const rows = mergeRepoRows({
      ...base,
      strays: [{ file: "Q4_K_M.gguf", rel: "main/Q4_K_M.gguf" }],
    });
    expect(rows[0].state).toBe("stray");
    expect(rows[0].strayRel).toBe("main/Q4_K_M.gguf");
  });

  it("已下载的量化带出引用它的配置名", () => {
    const rows = mergeRepoRows({
      ...base,
      local: [{ rel: "hf/o/r/Q4_K_M.gguf", size: 100 }],
      configs: [{ rel: "hf/o/r/Q4_K_M.gguf", models: ["m1", "m2"] }],
    });
    expect(rows[0].models).toEqual(["m1", "m2"]);
  });

  // 裁定 2：present 行要带出磁盘真实相对路径，供任务 9「创建配置」链接直接取用
  it("present 行的 localRels 带出磁盘真实相对路径", () => {
    const rows = mergeRepoRows({ ...base, local: [{ rel: "hf/o/r/Q4_K_M.gguf", size: 100 }] });
    expect(rows[0].localRels).toEqual(["hf/o/r/Q4_K_M.gguf"]);
  });

  // 裁定 3 更正：暂停任务与 pending/downloading 一样算「进行中」（设计 §9.3），
  // 因为暂停意味着有个半成品 + 一个「继续」入口，显示成「未下载」会丢信息
  it("任务状态为暂停时状态仍为下载中，taskStatus 标记暂停", () => {
    const rows = mergeRepoRows({
      ...base,
      tasks: [{ file: "Q4_K_M.gguf", status: "paused", downloadedBytes: 30 }],
    });
    expect(rows[0].state).toBe("downloading");
    expect(rows[0].taskStatus).toBe("paused");
  });

  it("分片组一片下载中一片暂停时，taskStatus 取非暂停的那个（只要还有一片在下就不算暂停）", () => {
    const rows = mergeRepoRows({
      ...base,
      groups: [{
        quant: "Q4_K_M", label: "Q4_K_M", kind: "model",
        files: [
          { path: "m-00001-of-00002.gguf", size: 10 },
          { path: "m-00002-of-00002.gguf", size: 10 },
        ],
        totalSize: 20, shards: 2, shardTotalDeclared: 2,
      }],
      tasks: [
        { file: "m-00001-of-00002.gguf", status: "downloading", downloadedBytes: 5 },
        { file: "m-00002-of-00002.gguf", status: "paused", downloadedBytes: 3 },
      ],
    });
    expect(rows[0].state).toBe("downloading");
    expect(rows[0].taskStatus).toBe("downloading");
  });

  // 复核修正：strayRel 不该随 state 清空——partial 行（一部分分片在档案目录内、
  // 另一部分散落别处）也需要 strayRel 才能给出「归位」动作，否则详情页对这种
  // 行是个死胡同（设计 §9.3 把「在别处」排在「部分」之前正是因为这个动作最要紧）
  it("分片组部分到齐、其余分片在别处时，partial 行也带出 strayRel", () => {
    const rows = mergeRepoRows({
      ...base,
      groups: [{
        quant: "Q4_K_M", label: "Q4_K_M", kind: "model",
        files: [
          { path: "m-00001-of-00003.gguf", size: 10 },
          { path: "m-00002-of-00003.gguf", size: 10 },
          { path: "m-00003-of-00003.gguf", size: 10 },
        ],
        totalSize: 30, shards: 3, shardTotalDeclared: 3,
      }],
      local: [{ rel: "hf/o/r/m-00001-of-00003.gguf", size: 10 }],
      strays: [
        { file: "m-00002-of-00003.gguf", rel: "main/m-00002-of-00003.gguf" },
        { file: "m-00003-of-00003.gguf", rel: "main/m-00003-of-00003.gguf" },
      ],
    });
    expect(rows[0].state).toBe("partial");
    expect(rows[0].haveShards).toBe(1);
    expect(rows[0].strayRel).toBe("main/m-00002-of-00003.gguf");
  });
});
