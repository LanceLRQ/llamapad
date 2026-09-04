import { describe, expect, it } from "vitest";
import { buildGroupingRows, groupRowsByDir, hasSubdirs, isSelectable, localOnlyRows, matchedRemoteGroup, mergeRepoRows, retainedSelection, sameQuantIdentity, summarizeRepoRows, type RepoRow, type RepoRowInput, type RepoRowState } from "./repo-files-view";

// 合法的内容 sha256（version-drift.ts 的 SHA256_PATTERN 要求 64 位小写十六进制）
const OID_A = "a".repeat(64);
const OID_B = "b".repeat(64);

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
      strays: [{ file: "Q4_K_M.gguf", rel: "main/Q4_K_M.gguf", size: 100 }],
    });
    expect(rows[0].state).toBe("stray");
    expect(rows[0].strayRels).toEqual(["main/Q4_K_M.gguf"]);
  });

  // I4 回归锁：basename 撞车但大小不等——大概率是另一个仓库的同名文件，
  // 或是没下完的半成品，两种都不该给出「归位」按钮
  it("同名但 size 不等的 stray 不被匹配，行仍是未下载", () => {
    const rows = mergeRepoRows({
      ...base,
      strays: [{ file: "Q4_K_M.gguf", rel: "main/Q4_K_M.gguf", size: 999 }],
    });
    expect(rows[0].state).toBe("absent");
    expect(rows[0].strayRels).toEqual([]);
  });

  it("同名且 size 相等的 stray 正常匹配成在别处", () => {
    const rows = mergeRepoRows({
      ...base,
      strays: [{ file: "Q4_K_M.gguf", rel: "main/Q4_K_M.gguf", size: 100 }],
    });
    expect(rows[0].state).toBe("stray");
    expect(rows[0].strayRels).toEqual(["main/Q4_K_M.gguf"]);
  });

  // I4 返工 1 回归锁：全盘有多个同名 stray 时，size 匹配必须在全部同名候选
  // 里找，不能只看先登记的那个——先到先得会把先登记但 size 不符的那个占住
  // 位置，让后面 size 正好对上的真身完全没机会被看到（用户早先手动下过一个
  // 同名文件放在别处，真身其实在另一个位置，这正是 I4 要处理的现实场景）
  it("全盘有多个同名 stray 时，按 size 找到匹配的那一个，不被先登记的错误候选挡住", () => {
    const rows = mergeRepoRows({
      ...base,
      strays: [
        { file: "Q4_K_M.gguf", rel: "main/Q4_K_M.gguf", size: 500 },
        { file: "Q4_K_M.gguf", rel: "downloads/Q4_K_M.gguf", size: 100 },
      ],
    });
    expect(rows[0].state).toBe("stray");
    expect(rows[0].strayRels).toEqual(["downloads/Q4_K_M.gguf"]);
  });

  // I4：远端声明大小不是正数（0/缺失）时一律不匹配任何 stray——宁可显示
  // 「未下载」，也不能凭一个文件名就给出「把某个不知道是什么的文件搬进来」
  // 的按钮
  it("远端声明 size 为 0 时不匹配任何 stray", () => {
    const rows = mergeRepoRows({
      ...base,
      groups: [
        { quant: "Q4_K_M", label: "Q4_K_M", kind: "model", files: [{ path: "Q4_K_M.gguf", size: 0 }], totalSize: 0, shards: 1, shardTotalDeclared: null },
      ],
      strays: [{ file: "Q4_K_M.gguf", rel: "main/Q4_K_M.gguf", size: 0 }],
    });
    expect(rows[0].state).toBe("absent");
    expect(rows[0].strayRels).toEqual([]);
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

  // 复核修正：strayRels 不该随 state 清空——partial 行（一部分分片在档案目录内、
  // 另一部分散落别处）也需要 strayRels 才能给出「归位」动作，否则详情页对这种
  // 行是个死胡同（设计 §9.3 把「在别处」排在「部分」之前正是因为这个动作最要紧）。
  // 任务 11 起不再只认第一片：两个散落分片都要出现在 strayRels 里
  it("分片组部分到齐、其余分片在别处时，partial 行也带出全部 strayRels", () => {
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
        { file: "m-00002-of-00003.gguf", rel: "main/m-00002-of-00003.gguf", size: 10 },
        { file: "m-00003-of-00003.gguf", rel: "main/m-00003-of-00003.gguf", size: 10 },
      ],
    });
    expect(rows[0].state).toBe("partial");
    expect(rows[0].haveShards).toBe(1);
    expect(rows[0].strayRels).toEqual(["main/m-00002-of-00003.gguf", "main/m-00003-of-00003.gguf"]);
  });

  // 任务 11：多分片组每一片各自的 stray 位置都要记下来，不再像早前那样一遇到
  // 第一个匹配就早退——27B/70B 这类多分片模型散落多处时，「归位」只搬走一片
  // 会留下一个既非完整又找不到剩余分片的死胡同
  it("多分片组逐片记录 stray，不再只认第一片", () => {
    const rows = mergeRepoRows({
      groups: [{
        quant: "Q4_K_M", label: "Q4_K_M", kind: "model", shards: 2, shardTotalDeclared: 2,
        totalSize: 200,
        files: [
          { path: "m-00001-of-00002.gguf", size: 100, oid: "a".repeat(64) },
          { path: "m-00002-of-00002.gguf", size: 100, oid: "b".repeat(64) },
        ],
      }],
      local: [],
      strays: [
        { file: "m-00001-of-00002.gguf", rel: "loose/m-00001-of-00002.gguf", size: 100, inRepoDir: null },
        { file: "m-00002-of-00002.gguf", rel: "loose/m-00002-of-00002.gguf", size: 100, inRepoDir: null },
      ],
      tasks: [], configs: [], targetDir: "hf/o/R",
    });
    expect(rows[0]!.strayRels).toEqual([
      "loose/m-00001-of-00002.gguf",
      "loose/m-00002-of-00002.gguf",
    ]);
  });

  // I1：任务 11 把 strays 放宽成「只排除本档案」后，strayRels 混装了游离文件与
  // 落在别的档案目录里的文件。「归位」走 planFileMove，而它明确拒绝把档案目录内
  // 的文件单独移出（fromRepo !== null → INVALID_PATH），混装提交必然 400
  it("stray 落在别的档案目录里：不进可归位那一路，但仍出现在展示那一路并标出所属档案", () => {
    const rows = mergeRepoRows({
      ...base,
      strays: [{ file: "Q4_K_M.gguf", rel: "hf/other/R/Q4_K_M.gguf", size: 100, inRepoDir: "hf/other/R" }],
    });
    expect(rows[0]!.state).toBe("stray");
    expect(rows[0]!.strayRels).toEqual(["hf/other/R/Q4_K_M.gguf"]); // 展示不能丢
    expect(rows[0]!.relocatableRels).toEqual([]); // 但归位按钮拿不到 from
    expect(rows[0]!.strayRepoDirs).toEqual(["hf/other/R"]);
  });

  it("混装（一片游离、一片在别的档案里）：两路各自只收自己那一半", () => {
    const rows = mergeRepoRows({
      groups: [{
        quant: "Q4_K_M", label: "Q4_K_M", kind: "model", shards: 2, shardTotalDeclared: 2,
        totalSize: 200,
        files: [
          { path: "m-00001-of-00002.gguf", size: 100 },
          { path: "m-00002-of-00002.gguf", size: 100 },
        ],
      }],
      local: [],
      strays: [
        { file: "m-00001-of-00002.gguf", rel: "loose/m-00001-of-00002.gguf", size: 100, inRepoDir: null },
        { file: "m-00002-of-00002.gguf", rel: "hf/other/R/m-00002-of-00002.gguf", size: 100, inRepoDir: "hf/other/R" },
      ],
      tasks: [], configs: [], targetDir: "hf/o/R",
    });
    expect(rows[0]!.strayRels).toEqual([
      "loose/m-00001-of-00002.gguf",
      "hf/other/R/m-00002-of-00002.gguf",
    ]);
    expect(rows[0]!.relocatableRels).toEqual(["loose/m-00001-of-00002.gguf"]);
    expect(rows[0]!.strayRepoDirs).toEqual(["hf/other/R"]);
  });

  it("inRepoDir 缺省（旧调用方/夹具不传）按游离处理，两路口径不变", () => {
    const rows = mergeRepoRows({
      ...base,
      strays: [{ file: "Q4_K_M.gguf", rel: "loose/Q4_K_M.gguf", size: 100 }],
    });
    expect(rows[0]!.relocatableRels).toEqual(["loose/Q4_K_M.gguf"]);
    expect(rows[0]!.strayRepoDirs).toEqual([]);
  });

  it("同一档案内的多片散落在别处时 strayRepoDirs 去重", () => {
    const rows = mergeRepoRows({
      groups: [{
        quant: "Q4_K_M", label: "Q4_K_M", kind: "model", shards: 2, shardTotalDeclared: 2,
        totalSize: 200,
        files: [
          { path: "m-00001-of-00002.gguf", size: 100 },
          { path: "m-00002-of-00002.gguf", size: 100 },
        ],
      }],
      local: [],
      strays: [
        { file: "m-00001-of-00002.gguf", rel: "hf/other/R/m-00001-of-00002.gguf", size: 100, inRepoDir: "hf/other/R" },
        { file: "m-00002-of-00002.gguf", rel: "hf/other/R/m-00002-of-00002.gguf", size: 100, inRepoDir: "hf/other/R" },
      ],
      tasks: [], configs: [], targetDir: "hf/o/R",
    });
    expect(rows[0]!.strayRepoDirs).toEqual(["hf/other/R"]);
  });

  // 缺陷 3 回归锁（批 1）：unsloth 类仓库的 group.files[].path 带子目录前缀
  // （HF 按 f.path 下载天然产生），route 出口 tasks[].file 必须已经是 basename
  // 才能与本函数按 basename 建的 key 对上——否则子目录仓库恒 miss，正在下载的
  // 量化被误判为「未下载」。这里锁定 mergeRepoRows 一侧的契约：tasks[].file
  // 传 basename 时能正确匹配到带子目录前缀的 group.files。
  it("group.files 带子目录前缀时，tasks[].file 传 basename 仍能正确匹配为下载中", () => {
    const rows = mergeRepoRows({
      ...base,
      groups: [{
        quant: "UD-Q4_K_XL", label: "UD-Q4_K_XL", kind: "model",
        files: [{ path: "UD-Q4_K_XL/model-00001-of-00002.gguf", size: 100 }],
        totalSize: 100, shards: 1, shardTotalDeclared: null,
      }],
      tasks: [{ file: "model-00001-of-00002.gguf", status: "downloading", downloadedBytes: 40 }],
    });
    expect(rows[0].state).toBe("downloading");
    expect(rows[0].progress).toBeCloseTo(0.4);
  });

  // 任务 15：sharedWith 是共用标注徽章的数据来源，来自 scanRepoFiles 的 local
  // 逐文件字段，本函数需要把它带到行级别
  it("present 行带出本地文件的 sharedWith", () => {
    const rows = mergeRepoRows({
      ...base,
      local: [{ rel: "hf/o/r/Q4_K_M.gguf", size: 100, sharedWith: ["main/Q4_K_M.gguf"] }],
    });
    expect(rows[0].sharedWith).toEqual(["main/Q4_K_M.gguf"]);
  });

  it("本地文件没有 sharedWith 字段（旧夹具）时行的 sharedWith 为空数组", () => {
    const rows = mergeRepoRows({
      ...base,
      local: [{ rel: "hf/o/r/Q4_K_M.gguf", size: 100 }],
    });
    expect(rows[0].sharedWith).toEqual([]);
  });

  it("分片组内多个文件各自的 sharedWith 取并集去重", () => {
    const rows = mergeRepoRows({
      groups: [{
        quant: "Q4_K_M", label: "Q4_K_M", kind: "model", shards: 2, shardTotalDeclared: 2,
        totalSize: 20,
        files: [
          { path: "m-00001-of-00002.gguf", size: 10 },
          { path: "m-00002-of-00002.gguf", size: 10 },
        ],
      }],
      local: [
        { rel: "hf/o/r/m-00001-of-00002.gguf", size: 10, sharedWith: ["loose/m-00001-of-00002.gguf"] },
        { rel: "hf/o/r/m-00002-of-00002.gguf", size: 10, sharedWith: ["loose/m-00002-of-00002.gguf"] },
      ],
      strays: [], tasks: [], configs: [], targetDir: "hf/o/r",
    });
    expect(rows[0]!.sharedWith).toEqual(["loose/m-00001-of-00002.gguf", "loose/m-00002-of-00002.gguf"]);
  });

  // 规格 §5.1：档案目录内的文件此前只按 basename 匹配、一律显示「已下载」，
  // 版本旧了也看不出来。这一批起 local[].drift 由路由侧算好喂进来，present
  // 行据此再分出「有更新」。同一断言顺带覆盖控制者追加的 localSize/remoteSize：
  // 本地实测 200、远端声明 100 时两个字段要如实带出，供后续任务渲染差值
  it("档案目录内的文件 drift 为 different → 行状态 present 且 hasUpdate 为 true", () => {
    const rows = mergeRepoRows({
      ...base,
      groups: [{
        quant: "Q4_K_M", label: "Q4_K_M", kind: "model",
        files: [{ path: "a.gguf", size: 100, oid: OID_A }],
        totalSize: 100, shards: 1, shardTotalDeclared: null,
      }],
      local: [{ rel: "hf/o/r/a.gguf", size: 200, drift: "different" }],
    });
    expect(rows[0]!.state).toBe("present");
    expect(rows[0]!.hasUpdate).toBe(true);
    expect(rows[0]!.unverified).toBe(false);
    expect(rows[0]!.localSize).toBe(200);
    expect(rows[0]!.remoteSize).toBe(100);
  });

  it("drift 为 unknown → present 且 unverified 为 true，不算有更新", () => {
    const rows = mergeRepoRows({
      ...base,
      groups: [{
        quant: "Q4_K_M", label: "Q4_K_M", kind: "model",
        files: [{ path: "a.gguf", size: 100, oid: OID_A }],
        totalSize: 100, shards: 1, shardTotalDeclared: null,
      }],
      local: [{ rel: "hf/o/r/a.gguf", size: 100, drift: "unknown" }],
    });
    expect(rows[0]!.hasUpdate).toBe(false);
    expect(rows[0]!.unverified).toBe(true);
  });

  it("drift 缺省（旧夹具不传）→ 两个标志都是 false，行为与改动前一致", () => {
    const rows = mergeRepoRows({
      ...base,
      groups: [{
        quant: "Q4_K_M", label: "Q4_K_M", kind: "model",
        files: [{ path: "a.gguf", size: 100, oid: OID_A }],
        totalSize: 100, shards: 1, shardTotalDeclared: null,
      }],
      local: [{ rel: "hf/o/r/a.gguf", size: 100 }],
    });
    expect(rows[0]!.hasUpdate).toBe(false);
    expect(rows[0]!.unverified).toBe(false);
  });

  it("分片组只要有一片 different，整组算有更新", () => {
    const rows = mergeRepoRows({
      ...base,
      groups: [{
        quant: "Q4_K_M", label: "Q4_K_M", kind: "model", shards: 2, shardTotalDeclared: 2,
        totalSize: 200,
        files: [
          { path: "a-1.gguf", size: 100, oid: OID_A },
          { path: "a-2.gguf", size: 100, oid: OID_B },
        ],
      }],
      local: [
        { rel: "hf/o/r/a-1.gguf", size: 100, drift: "same" },
        { rel: "hf/o/r/a-2.gguf", size: 100, drift: "different" },
      ],
    });
    expect(rows[0]!.hasUpdate).toBe(true);
  });

  // 复核发现（Important）：unverified 判定里的 !anyDifferent guard 此前没有任何
  // 用例触发过——它存在的唯一意义是「组内同时出现 different 与 unknown 时，
  // hasUpdate 优先于 unverified」（RepoRow.unverified 字段注释「与 hasUpdate
  // 互斥展示，有更新优先」）。这条用例专门构造一片 different、一片 unknown 的
  // 分片组：若 guard 被删掉，unverified 会被误判为 true，与 hasUpdate 同时展示
  it("分片组一片 different 一片 unknown：hasUpdate 优先，unverified 不跟着为 true", () => {
    const rows = mergeRepoRows({
      ...base,
      groups: [{
        quant: "Q4_K_M", label: "Q4_K_M", kind: "model", shards: 2, shardTotalDeclared: 2,
        totalSize: 200,
        files: [
          { path: "a-1.gguf", size: 100, oid: OID_A },
          { path: "a-2.gguf", size: 100, oid: OID_B },
        ],
      }],
      local: [
        { rel: "hf/o/r/a-1.gguf", size: 100, drift: "different" },
        { rel: "hf/o/r/a-2.gguf", size: 100, drift: "unknown" },
      ],
    });
    expect(rows[0]!.hasUpdate).toBe(true);
    expect(rows[0]!.unverified).toBe(false);
  });

  // 控制者追加要求：本地缺失时 localSize 取 null（不是 0——0 是"量出来的大小
  // 恰好为零"，与"压根没量到"是两件事），remoteSize 仍如实带出远端声明大小，
  // 不因为本地没有文件就一起变成 null
  it("本地缺失时 localSize 为 null，remoteSize 仍带出远端声明大小", () => {
    const rows = mergeRepoRows(base);
    expect(rows[0]!.state).toBe("absent");
    expect(rows[0]!.localSize).toBeNull();
    expect(rows[0]!.remoteSize).toBe(100);
  });

  // localSize 只累加实际到齐的那几片，不是整组远端声明大小——partial 行的
  // 「本地实测」与「远端声明」本就该不一致，这正是后续任务要展示的差值来源
  it("partial 行的 localSize 只累加已到齐的分片，不含远端未到的部分", () => {
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
    expect(rows[0]!.state).toBe("partial");
    expect(rows[0]!.localSize).toBe(10);
    expect(rows[0]!.remoteSize).toBe(30);
  });
});

describe("isSelectable", () => {
  // 任务 11：本批引入硬链接后，「在别处」的档不再只能靠专门的「归位」按钮
  // 处理——它现在也能像 absent/partial 一样被勾选，交给 acquire 统一决定
  // 具体动作（同档案外链接/移动）
  it("stray 行可勾选——用户要能选中它再决定动作", () => {
    expect(isSelectable({ state: "stray" } as RepoRow)).toBe(true);
  });
});

describe("localOnlyRows", () => {
  it("空 local 给出空数组", () => {
    expect(localOnlyRows({ local: [], configs: [] })).toEqual([]);
  });

  it("每个本地文件独立成一行，state 恒为 present", () => {
    const rows = localOnlyRows({
      local: [{ rel: "hf/o/r/model-Q4_K_M.gguf", size: 100 }],
      configs: [],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("present");
    expect(rows[0].quant).toBe("Q4_K_M");
    expect(rows[0].kind).toBe("model");
    expect(rows[0].totalSize).toBe(100);
    expect(rows[0].haveShards).toBe(1);
    expect(rows[0].totalShards).toBe(1);
    expect(rows[0].localRels).toEqual(["hf/o/r/model-Q4_K_M.gguf"]);
    expect(rows[0].strayRels).toEqual([]);
    expect(rows[0].taskStatus).toBeNull();
    expect(rows[0].progress).toBeNull();
    // 降级路径没有远端清单可比对，版本关系无从谈起；localSize 就是这份
    // 本地文件的实测大小，remoteSize 没有基准，为 null（不是 0）
    expect(rows[0].hasUpdate).toBe(false);
    expect(rows[0].unverified).toBe(false);
    expect(rows[0].localSize).toBe(100);
    expect(rows[0].remoteSize).toBeNull();
  });

  it("mmproj 文件识别为 mmproj kind", () => {
    const rows = localOnlyRows({
      local: [{ rel: "hf/o/r/mmproj-F16.gguf", size: 50 }],
      configs: [],
    });
    expect(rows[0].kind).toBe("mmproj");
  });

  it("带出配置引用", () => {
    const rows = localOnlyRows({
      local: [{ rel: "hf/o/r/model-Q4_K_M.gguf", size: 100 }],
      configs: [{ rel: "hf/o/r/model-Q4_K_M.gguf", models: ["m1"] }],
    });
    expect(rows[0].models).toEqual(["m1"]);
  });

  it("带出 sharedWith；缺省为空数组", () => {
    const rows = localOnlyRows({
      local: [
        { rel: "hf/o/r/model-Q4_K_M.gguf", size: 100, sharedWith: ["main/model-Q4_K_M.gguf"] },
        { rel: "hf/o/r/model-Q8_0.gguf", size: 200 },
      ],
      configs: [],
    });
    expect(rows[0]!.sharedWith).toEqual(["main/model-Q4_K_M.gguf"]);
    expect(rows[1]!.sharedWith).toEqual([]);
  });
});

describe("summarizeRepoRows", () => {
  it("量化计数只数 model 行，不含 mmproj", () => {
    const rows = mergeRepoRows({
      ...base,
      groups: [
        ...base.groups,
        { quant: null, label: "未识别", kind: "mmproj", files: [{ path: "mmproj-F16.gguf", size: 20 }], totalSize: 20, shards: 1, shardTotalDeclared: null },
      ],
    });
    const summary = summarizeRepoRows(rows, []);
    expect(summary.quantCount).toBe(1);
  });

  it("已下载计数只数 state 为 present 的 model 行", () => {
    const rows = mergeRepoRows({ ...base, local: [{ rel: "hf/o/r/Q4_K_M.gguf", size: 100 }] });
    const summary = summarizeRepoRows(rows, [{ rel: "hf/o/r/Q4_K_M.gguf", size: 100 }]);
    expect(summary.downloadedCount).toBe(1);
    expect(summary.totalBytes).toBe(100);
  });

  it("占盘字节数直接取 local 之和，与 rows 的量化分组结果无关", () => {
    const rows = mergeRepoRows(base);
    const summary = summarizeRepoRows(rows, [{ rel: "main/stray.gguf", size: 30 }]);
    expect(summary.totalBytes).toBe(30);
  });

  // m8：D11 的 inode 去重此前只覆盖了列表页的 decorateProfileStats，详情页头
  // 这一路仍是裸求和——同一档案内两个硬链接会被算两次，磁盘其实只占一份
  it("同一档案内两个路径共用同一份数据时只算一次", () => {
    const rows = mergeRepoRows(base);
    const summary = summarizeRepoRows(rows, [
      { rel: "hf/o/r/a.gguf", size: 100, sharedWith: ["hf/o/r/b.gguf"] },
      { rel: "hf/o/r/b.gguf", size: 100, sharedWith: ["hf/o/r/a.gguf"] },
    ]);
    expect(summary.totalBytes).toBe(100);
  });

  it("三个路径共用同一份数据同样只算一次", () => {
    const rows = mergeRepoRows(base);
    const rels = ["hf/o/r/a.gguf", "hf/o/r/b.gguf", "hf/o/r/c.gguf"];
    const summary = summarizeRepoRows(
      rows,
      rels.map((rel) => ({ rel, size: 100, sharedWith: rels.filter((r) => r !== rel) })),
    );
    expect(summary.totalBytes).toBe(100);
  });

  it("共用对象在档案之外时本档案仍照常计入——它确实占着这些字节", () => {
    const rows = mergeRepoRows(base);
    const summary = summarizeRepoRows(rows, [
      { rel: "hf/o/r/a.gguf", size: 100, sharedWith: ["loose/a.gguf"] },
    ]);
    expect(summary.totalBytes).toBe(100);
  });

  it("没有共用关系时按各自 size 求和（sharedWith 缺省不影响既有口径）", () => {
    const rows = mergeRepoRows(base);
    const summary = summarizeRepoRows(rows, [
      { rel: "hf/o/r/a.gguf", size: 100, sharedWith: [] },
      { rel: "hf/o/r/b.gguf", size: 30 },
    ]);
    expect(summary.totalBytes).toBe(130);
  });
});

describe("sameQuantIdentity", () => {
  const model = (quant: string | null) => ({ quant, kind: "model" });
  const mmproj = (quant: string | null) => ({ quant, kind: "mmproj" });

  it("完全相同 → true", () => {
    expect(sameQuantIdentity([model("Q4_K_M"), mmproj(null)], [model("Q4_K_M"), mmproj(null)])).toBe(true);
  });

  it("两个空数组 → true", () => {
    expect(sameQuantIdentity([], [])).toBe(true);
  });

  it("长度不同 → false", () => {
    expect(sameQuantIdentity([model("Q4_K_M")], [model("Q4_K_M"), model("Q8_0")])).toBe(false);
  });

  it("顺序不同 → false", () => {
    expect(sameQuantIdentity([model("Q4_K_M"), model("Q8_0")], [model("Q8_0"), model("Q4_K_M")])).toBe(false);
  });

  it("某项 quant 由 null 变成具体值 → false", () => {
    expect(sameQuantIdentity([model(null)], [model("Q4_K_M")])).toBe(false);
  });

  it("kind 不同（model vs mmproj）→ false", () => {
    expect(sameQuantIdentity([model("Q4_K_M")], [mmproj("Q4_K_M")])).toBe(false);
  });
});

describe("retainedSelection", () => {
  const row = (state: RepoRowState): RepoRow => ({
    quant: "Q4_K_M",
    kind: "model",
    files: ["Q4_K_M.gguf"],
    totalSize: 100,
    state,
    progress: null,
    haveShards: 1,
    totalShards: 1,
    strayRels: [],
    relocatableRels: [],
    strayRepoDirs: [],
    models: [],
    localRels: [],
    sharedWith: [],
    taskStatus: null,
    hasUpdate: false,
    unverified: false,
    localSize: null,
    remoteSize: null,
  });

  it("身份变了：整体清空，不管 selected 与 nextRows 内容是什么", () => {
    const next = retainedSelection(new Set([0]), [row("absent")], false);
    expect(next).toEqual(new Set());
  });

  it("身份没变、行仍是 absent：保留", () => {
    const next = retainedSelection(new Set([0]), [row("absent")], true);
    expect(next).toEqual(new Set([0]));
  });

  it("身份没变、行变成 downloading：剔除（这正是下载重复入队那个真回归）", () => {
    const next = retainedSelection(new Set([0]), [row("downloading")], true);
    expect(next).toEqual(new Set());
  });

  it("身份没变、行变成 present：剔除", () => {
    const next = retainedSelection(new Set([0]), [row("present")], true);
    expect(next).toEqual(new Set());
  });

  // 任务 11 起 isSelectable 放行 stray：在别处的行可以被选中直接归位/下载，
  // 这条不再是「剔除」，与紧接着的 partial 用例同一种结果
  it("身份没变、行变成 stray：保留（isSelectable 已放行 stray）", () => {
    const next = retainedSelection(new Set([0]), [row("stray")], true);
    expect(next).toEqual(new Set([0]));
  });

  it("身份没变、行是 partial：保留", () => {
    const next = retainedSelection(new Set([0]), [row("partial")], true);
    expect(next).toEqual(new Set([0]));
  });

  it("下标越界（新清单更短）：剔除，不报错", () => {
    const next = retainedSelection(new Set([0, 5]), [row("absent")], true);
    expect(next).toEqual(new Set([0]));
  });

  it("空选中：返回空集", () => {
    const next = retainedSelection(new Set(), [row("absent")], true);
    expect(next).toEqual(new Set());
  });
});

describe("groupRowsByDir", () => {
  // groupRowsByDir 现在内部调 buildGroupingRows，把 rows.files（basename，生产
  // 环境的真实形态：mergeRepoRows 按 basename 收窄，供与 tasks/local 按名匹配）
  // 与 remoteGroups（带目录的完整路径）拼起来再分组——用例改用这个真实输入
  // 组合，不再直接在 RepoRow.files 里塞目录前缀（那是生产环境不会出现的形态，
  // 复核修复 G-2）
  const makeRow = ({ files }: { files: string[] }): RepoRow => ({
    quant: "Q4_K_M",
    kind: "model",
    files,
    totalSize: 100,
    state: "absent",
    progress: null,
    haveShards: 0,
    totalShards: files.length,
    strayRels: [],
    relocatableRels: [],
    strayRepoDirs: [],
    models: [],
    localRels: [],
    sharedWith: [],
    taskStatus: null,
    hasUpdate: false,
    unverified: false,
    localSize: null,
    remoteSize: null,
  });

  it("全在根目录 → 单个 dir 为空串的组，index 与入参下标一致", () => {
    const rows = [makeRow({ files: ["a.gguf"] }), makeRow({ files: ["b.gguf"] })];
    const remoteGroups = [{ files: [{ path: "a.gguf" }] }, { files: [{ path: "b.gguf" }] }];
    const groups = groupRowsByDir(rows, remoteGroups);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.dir).toBe("");
    expect(groups[0]?.entries.map((e) => e.index)).toEqual([0, 1]);
  });

  it("按目录分组，且每项带回原始下标（选中态靠它，不能错位）", () => {
    const rows = [
      makeRow({ files: ["a.gguf"] }),
      makeRow({ files: ["root.gguf"] }),
      makeRow({ files: ["b.gguf"] }),
    ];
    const remoteGroups = [
      { files: [{ path: "UD-Q4_K_XL/a.gguf" }] },
      { files: [{ path: "root.gguf" }] },
      { files: [{ path: "UD-Q4_K_XL/b.gguf" }] },
    ];
    const byDir = new Map(groupRowsByDir(rows, remoteGroups).map((g) => [g.dir, g.entries.map((e) => e.index)]));
    expect(byDir.get("")).toEqual([1]);
    expect(byDir.get("UD-Q4_K_XL")).toEqual([0, 2]);
  });

  it("根组永远排在最前，其余目录按字典序", () => {
    const rows = [makeRow({ files: ["x.gguf"] }), makeRow({ files: ["y.gguf"] }), makeRow({ files: ["z.gguf"] })];
    const remoteGroups = [
      { files: [{ path: "b-dir/x.gguf" }] },
      { files: [{ path: "a-dir/y.gguf" }] },
      { files: [{ path: "z.gguf" }] },
    ];
    expect(groupRowsByDir(rows, remoteGroups).map((g) => g.dir)).toEqual(["", "a-dir", "b-dir"]);
  });

  it("多层目录用完整路径做一个组，不拆成树", () => {
    const rows = [makeRow({ files: ["x.gguf"] })];
    const remoteGroups = [{ files: [{ path: "a/b/x.gguf" }] }];
    expect(groupRowsByDir(rows, remoteGroups)[0]?.dir).toBe("a/b");
  });

  it("一行内文件跨目录 → 归到根组（不猜）", () => {
    const rows = [makeRow({ files: ["x.gguf", "y.gguf"] })];
    const remoteGroups = [{ files: [{ path: "d1/x.gguf" }, { path: "d2/y.gguf" }] }];
    const groups = groupRowsByDir(rows, remoteGroups);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.dir).toBe("");
  });

  it("files 为空的行归到根组，不抛错", () => {
    expect(groupRowsByDir([makeRow({ files: [] })], null)[0]?.dir).toBe("");
  });

  it("分片组同目录 → 按该目录分组", () => {
    const rows = [makeRow({ files: ["m-00001-of-00002.gguf", "m-00002-of-00002.gguf"] })];
    const remoteGroups = [
      { files: [{ path: "BF16/m-00001-of-00002.gguf" }, { path: "BF16/m-00002-of-00002.gguf" }] },
    ];
    expect(groupRowsByDir(rows, remoteGroups)[0]?.dir).toBe("BF16");
  });

  it("hasSubdirs：只有根组时为 false，出现任一子目录为 true", () => {
    expect(hasSubdirs(groupRowsByDir([makeRow({ files: ["a.gguf"] })], [{ files: [{ path: "a.gguf" }] }]))).toBe(
      false,
    );
    expect(hasSubdirs(groupRowsByDir([makeRow({ files: ["a.gguf"] })], [{ files: [{ path: "d/a.gguf" }] }]))).toBe(
      true,
    );
  });

  it("remoteGroups 为 null 时整体回落成扁平——basename 没有目录信息，全部归根组", () => {
    const rows = [makeRow({ files: ["a.gguf"] }), makeRow({ files: ["b.gguf"] })];
    const groups = groupRowsByDir(rows, null);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.dir).toBe("");
  });
});

describe("buildGroupingRows", () => {
  const makeRow = ({ files }: { files: string[] }): RepoRow => ({
    quant: "Q4_K_M",
    kind: "model",
    files,
    totalSize: 100,
    state: "absent",
    progress: null,
    haveShards: 0,
    totalShards: files.length,
    strayRels: [],
    relocatableRels: [],
    strayRepoDirs: [],
    models: [],
    localRels: [],
    sharedWith: [],
    taskStatus: null,
    hasUpdate: false,
    unverified: false,
    localSize: null,
    remoteSize: null,
  });

  it("下标对齐、长度与 basename 都对得上时，回填带目录前缀的完整路径", () => {
    const rows = [makeRow({ files: ["a-Q4_K_M.gguf"] })];
    const remoteGroups = [{ files: [{ path: "UD-Q4_K_XL/a-Q4_K_M.gguf" }] }];
    const result = buildGroupingRows(rows, remoteGroups);
    expect(result[0]?.files).toEqual(["UD-Q4_K_XL/a-Q4_K_M.gguf"]);
    expect(result[0]?.files[0]).toContain("/");
  });

  it("remoteGroups 为 null 时整体原样回落", () => {
    const rows = [makeRow({ files: ["a-Q4_K_M.gguf"] })];
    const result = buildGroupingRows(rows, null);
    expect(result[0]?.files).toEqual(["a-Q4_K_M.gguf"]);
  });

  it("remoteGroups 为 undefined 时整体原样回落", () => {
    const rows = [makeRow({ files: ["a-Q4_K_M.gguf"] })];
    const result = buildGroupingRows(rows, undefined);
    expect(result[0]?.files).toEqual(["a-Q4_K_M.gguf"]);
  });

  it("该行文件数与远端组文件数不一致时，该行原样回落", () => {
    const rows = [makeRow({ files: ["a-Q4_K_M.gguf"] })];
    const remoteGroups = [{ files: [{ path: "dir/a-Q4_K_M.gguf" }, { path: "dir/b-Q4_K_M.gguf" }] }];
    const result = buildGroupingRows(rows, remoteGroups);
    expect(result[0]?.files).toEqual(["a-Q4_K_M.gguf"]);
  });

  it("长度相等但 basename 逐个核对不上（错位）时，该行原样回落", () => {
    const rows = [makeRow({ files: ["a-Q4_K_M.gguf"] })];
    const remoteGroups = [{ files: [{ path: "dir/b-Q4_K_M.gguf" }] }];
    const result = buildGroupingRows(rows, remoteGroups);
    expect(result[0]?.files).toEqual(["a-Q4_K_M.gguf"]);
  });

  it("多行中只有对不上的那一行回落，其余行正常回填", () => {
    const rows = [makeRow({ files: ["a.gguf"] }), makeRow({ files: ["b.gguf"] })];
    const remoteGroups = [
      { files: [{ path: "dir1/a.gguf" }] },
      { files: [{ path: "dir2/b.gguf" }, { path: "dir2/c.gguf" }] }, // 长度不符
    ];
    const result = buildGroupingRows(rows, remoteGroups);
    expect(result[0]?.files).toEqual(["dir1/a.gguf"]);
    expect(result[1]?.files).toEqual(["b.gguf"]);
  });
});

describe("matchedRemoteGroup", () => {
  const row = { files: ["a.gguf", "b.gguf"] };

  it("下标、长度、逐个 basename 都对得上时，返回该远端组", () => {
    const remoteGroups = [{ files: [{ path: "dir/a.gguf" }, { path: "dir/b.gguf" }] }];
    expect(matchedRemoteGroup(row, remoteGroups, 0)).toBe(remoteGroups[0]);
  });

  it("remoteGroups 为 null 时返回 null", () => {
    expect(matchedRemoteGroup(row, null, 0)).toBeNull();
  });

  it("remoteGroups 为 undefined 时返回 null", () => {
    expect(matchedRemoteGroup(row, undefined, 0)).toBeNull();
  });

  it("下标越界（remoteGroups[index] 不存在）时返回 null", () => {
    const remoteGroups = [{ files: [{ path: "a.gguf" }, { path: "b.gguf" }] }];
    expect(matchedRemoteGroup(row, remoteGroups, 1)).toBeNull();
  });

  it("文件数不一致时返回 null", () => {
    const remoteGroups = [{ files: [{ path: "a.gguf" }] }];
    expect(matchedRemoteGroup(row, remoteGroups, 0)).toBeNull();
  });

  it("长度相等但 basename 错位时返回 null", () => {
    const remoteGroups = [{ files: [{ path: "a.gguf" }, { path: "c.gguf" }] }];
    expect(matchedRemoteGroup(row, remoteGroups, 0)).toBeNull();
  });
});
