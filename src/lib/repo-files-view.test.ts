import { describe, expect, it } from "vitest";
import { groupRepoFiles } from "@/core/quant";
import { isSelectable, localOnlyRows, matchedRemoteGroup, mergeRepoRows, retainedSelection, sameGroupIdentity, summarizeRepoRows, type RepoRow, type RepoRowInput, type RepoRowState } from "./repo-files-view";

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

  it("旧版归位到档案根目录的文件在远端文件名唯一且大小相符时仍算已下载", () => {
    const file = { path: "Q4/model.gguf", size: 100 };
    const local = [{ rel: "hf/o/r/model.gguf", size: 100, drift: "different" as const }];
    expect(mergeRepoRows({ ...base, local, groups: groupRepoFiles([file]) })[0])
      .toMatchObject({ state: "present", localRels: ["hf/o/r/model.gguf"], hasLegacyPaths: true, hasUpdate: true });

    const ambiguous = groupRepoFiles([file, { ...file, path: "mtp/model.gguf" }]);
    expect(mergeRepoRows({ ...base, local, groups: ambiguous }).map((row) => row.state))
      .toEqual(["absent", "absent"]);
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

  // K-1 复核修复：basename 命中但没有一个候选 size 对得上——此前这条信息
  // 被 I4 精确门直接丢弃，行上完全沉默。改为进 driftStrays（展示专用，
  // 不进 strayRels，不影响「归位」判据）
  it("size 不符的同名 stray 进 driftStrays，不进 strayRels", () => {
    const rows = mergeRepoRows({
      ...base,
      strays: [{ file: "Q4_K_M.gguf", rel: "main/Q4_K_M.gguf", size: 80 }],
    });
    expect(rows[0].strayRels).toEqual([]);
    expect(rows[0].driftStrays).toEqual([{ rel: "main/Q4_K_M.gguf", localSize: 80, remoteSize: 100 }]);
  });

  it("size 相符的同名 stray 照旧只进 strayRels，不进 driftStrays", () => {
    const rows = mergeRepoRows({
      ...base,
      strays: [{ file: "Q4_K_M.gguf", rel: "main/Q4_K_M.gguf", size: 100 }],
    });
    expect(rows[0].strayRels).toEqual(["main/Q4_K_M.gguf"]);
    expect(rows[0].driftStrays).toEqual([]);
  });

  it("远端声明 size 为 0 时 driftStrays 也不记（与 I4 同一条件）", () => {
    const rows = mergeRepoRows({
      ...base,
      groups: [
        { quant: "Q4_K_M", label: "Q4_K_M", kind: "model", files: [{ path: "Q4_K_M.gguf", size: 0 }], totalSize: 0, shards: 1, shardTotalDeclared: null },
      ],
      strays: [{ file: "Q4_K_M.gguf", rel: "main/Q4_K_M.gguf", size: 999 }],
    });
    expect(rows[0].strayRels).toEqual([]);
    expect(rows[0].driftStrays).toEqual([]);
  });

  it("同一 basename 多个候选都不符时，取与远端声明大小差值最小的那个进 driftStrays", () => {
    const rows = mergeRepoRows({
      ...base,
      strays: [
        { file: "Q4_K_M.gguf", rel: "main/Q4_K_M.gguf", size: 50 },
        { file: "Q4_K_M.gguf", rel: "downloads/Q4_K_M.gguf", size: 90 },
        { file: "Q4_K_M.gguf", rel: "loose/Q4_K_M.gguf", size: 200 },
      ],
    });
    expect(rows[0].strayRels).toEqual([]);
    expect(rows[0].driftStrays).toEqual([{ rel: "downloads/Q4_K_M.gguf", localSize: 90, remoteSize: 100 }]);
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

  it("按完整路径匹配同名文件各自的下载任务和本地状态", () => {
    const rows = mergeRepoRows({
      ...base,
      groups: [
        ...base.groups,
        { ...base.groups[0], files: [{ path: "Q4/Q4_K_M.gguf", size: 100 }] },
        { ...base.groups[0], files: [{ path: "MTP/Q4_K_M.gguf", size: 100 }] },
      ],
      local: [{ rel: "hf/o/r/Q4/Q4_K_M.gguf", size: 100 }],
      tasks: [{ file: "Q4_K_M.gguf", path: "MTP/Q4_K_M.gguf", status: "downloading", downloadedBytes: 40 }],
    });
    expect(rows.map(({ files, state }) => [files[0], state])).toEqual([
      ["Q4_K_M.gguf", "absent"],
      ["Q4/Q4_K_M.gguf", "present"],
      ["MTP/Q4_K_M.gguf", "downloading"],
    ]);
    expect(rows[2].progress).toBeCloseTo(0.4);
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
    expect(localOnlyRows({ targetDir: "hf/o/r", local: [], configs: [] })).toEqual([]);
  });

  it("远端不可用时以本地路径保留整套分片，并标记缺片", () => {
    const rows = localOnlyRows({
      targetDir: "hf/o/r",
      configs: [],
      local: [
        { rel: "hf/o/r/Q4/a-00001-of-00002.gguf", size: 10 },
        { rel: "hf/o/r/Q4/a-00002-of-00002.gguf", size: 20 },
        { rel: "hf/o/r/Q8/a-00001-of-00002.gguf", size: 20 },
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      files: ["Q4/a-00001-of-00002.gguf", "Q4/a-00002-of-00002.gguf"], state: "present", remoteSize: null,
    });
    expect(rows[1]).toMatchObject({
      files: ["Q8/a-00001-of-00002.gguf"], state: "partial", haveShards: 1, totalShards: 2,
    });
  });

  it("每个本地文件独立成一行，state 恒为 present", () => {
    const rows = localOnlyRows({ targetDir: "hf/o/r",
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
    const rows = localOnlyRows({ targetDir: "hf/o/r",
      local: [{ rel: "hf/o/r/mmproj-F16.gguf", size: 50 }],
      configs: [],
    });
    expect(rows[0].kind).toBe("mmproj");
  });

  it("带出配置引用", () => {
    const rows = localOnlyRows({ targetDir: "hf/o/r",
      local: [{ rel: "hf/o/r/model-Q4_K_M.gguf", size: 100 }],
      configs: [{ rel: "hf/o/r/model-Q4_K_M.gguf", models: ["m1"] }],
    });
    expect(rows[0].models).toEqual(["m1"]);
  });

  it("带出 sharedWith；缺省为空数组", () => {
    const rows = localOnlyRows({ targetDir: "hf/o/r",
      local: [
        { rel: "hf/o/r/model-Q4_K_M.gguf", size: 100, sharedWith: ["main/model-Q4_K_M.gguf"] },
        { rel: "hf/o/r/model-Q8_0.gguf", size: 200 },
      ],
      configs: [],
    });
    expect(rows.find((r) => r.files[0] === "model-Q4_K_M.gguf")?.sharedWith).toEqual(["main/model-Q4_K_M.gguf"]);
    expect(rows.find((r) => r.files[0] === "model-Q8_0.gguf")?.sharedWith).toEqual([]);
  });
});

describe("summarizeRepoRows", () => {
  it("文件计数包含 mmproj 和其他 GGUF 条目", () => {
    const rows = mergeRepoRows({
      ...base,
      groups: [
        ...base.groups,
        { quant: null, label: "未识别", kind: "mmproj", files: [{ path: "mmproj-F16.gguf", size: 20 }], totalSize: 20, shards: 1, shardTotalDeclared: null },
      ],
    });
    const summary = summarizeRepoRows(rows, []);
    expect(summary.fileCount).toBe(2);
  });

  it("已下载计数只数 state 为 present 的 model 行", () => {
    const rows = mergeRepoRows({ ...base, local: [{ rel: "hf/o/r/Q4_K_M.gguf", size: 100 }] });
    const summary = summarizeRepoRows(rows, [{ rel: "hf/o/r/Q4_K_M.gguf", size: 100 }]);
    expect(summary.downloadedCount).toBe(1);
    expect(summary.totalBytes).toBe(100);
  });

  it("存储空间占用字节数直接取 local 之和，与 rows 的量化分组结果无关", () => {
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

describe("sameGroupIdentity", () => {
  // 身份口径已从 (quant, kind) 改成 kind + 组内文件名列表，夹具相应从
  // "quant 标签" 改成"仓库内相对路径"；6 条旧用例的语义原样保留，只是
  // 表达手段从 quant 换成了文件名
  const group = (kind: string, paths: readonly string[]) => ({
    kind,
    files: paths.map((path) => ({ path })),
  });

  it("完全相同 → true", () => {
    expect(
      sameGroupIdentity(
        [group("model", ["Q4_K_M.gguf"]), group("mmproj", ["mmproj-未识别.gguf"])],
        [group("model", ["Q4_K_M.gguf"]), group("mmproj", ["mmproj-未识别.gguf"])],
      ),
    ).toBe(true);
  });

  it("两个空数组 → true", () => {
    expect(sameGroupIdentity([], [])).toBe(true);
  });

  it("长度不同 → false", () => {
    expect(
      sameGroupIdentity(
        [group("model", ["Q4_K_M.gguf"])],
        [group("model", ["Q4_K_M.gguf"]), group("model", ["Q8_0.gguf"])],
      ),
    ).toBe(false);
  });

  it("顺序不同 → false", () => {
    expect(
      sameGroupIdentity(
        [group("model", ["Q4_K_M.gguf"]), group("model", ["Q8_0.gguf"])],
        [group("model", ["Q8_0.gguf"]), group("model", ["Q4_K_M.gguf"])],
      ),
    ).toBe(false);
  });

  // 原用例是"quant 由 null 变成具体值"，新签名不带 quant，改用文件名不同
  // 表达同一件事：两批清单里同位置的组已经不是同一个文件
  it("同位置组的文件名不同 → false", () => {
    expect(
      sameGroupIdentity([group("model", ["未识别.gguf"])], [group("model", ["Q4_K_M.gguf"])]),
    ).toBe(false);
  });

  it("kind 不同（model vs mmproj）→ false", () => {
    expect(
      sameGroupIdentity([group("model", ["Q4_K_M.gguf"])], [group("mmproj", ["Q4_K_M.gguf"])]),
    ).toBe(false);
  });

  // 本次修复的核心用例：真机 unsloth 仓库同一个 (quant, kind) 下有两个组
  // ——Qwen3.8-27B-Q4_0.gguf（仓库根目录）与 MTP/mtp-Qwen3.8-27B-Q4_0.gguf——
  // 旧实现只比 (quant, kind)，会把 [root, mtp] 与 [root, other] 判成"同一份
  // 清单"，selected 下标被错误地原样保留，用户勾中的其实是另一组。改成比
  // 文件名列表后，root 组虽然两边都出现，但第二个组文件名不同，必须 false
  it("同 (quant, kind) 但文件名不同的两个组 → false（旧实现在这里误判为 true）", () => {
    const root = group("model", ["Qwen3.8-27B-Q4_0.gguf"]);
    const mtp = group("model", ["MTP/mtp-Qwen3.8-27B-Q4_0.gguf"]);
    const other = group("model", ["AWQ/awq-Qwen3.8-27B-Q4_0.gguf"]);
    expect(sameGroupIdentity([root, mtp], [root, other])).toBe(false);
  });

  it("同一批组原样比对（含多分片组）→ true，证明判据不是恒 false", () => {
    const groups = [
      group("model", ["model-00001-of-00002.gguf", "model-00002-of-00002.gguf"]),
      group("mmproj", ["mmproj-F16.gguf"]),
    ];
    expect(sameGroupIdentity(groups, groups)).toBe(true);
  });

  it("分片组内文件顺序不同 → false", () => {
    const a = [group("model", ["model-00001-of-00002.gguf", "model-00002-of-00002.gguf"])];
    const b = [group("model", ["model-00002-of-00002.gguf", "model-00001-of-00002.gguf"])];
    expect(sameGroupIdentity(a, b)).toBe(false);
  });
});

describe("retainedSelection", () => {
  const row = (state: RepoRowState): RepoRow => ({
    quant: "Q4_K_M",
    kind: "model",
    mtpKind: "none",
    files: ["Q4_K_M.gguf"],
    totalSize: 100,
    state,
    progress: null,
    haveShards: 1,
    totalShards: 1,
    strayRels: [],
    relocatableRels: [],
    strayRepoDirs: [],
    driftStrays: [],
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

describe("matchedRemoteGroup", () => {
  const row = { files: ["dir/a.gguf", "dir/b.gguf"] };

  it("下标、长度、逐个完整路径 都对得上时，返回该远端组", () => {
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

  it("文件名相同但仓库内目录不同时返回 null", () => {
    const remoteGroups = [{ files: [{ path: "a.gguf" }, { path: "b.gguf" }] }];
    expect(matchedRemoteGroup(row, remoteGroups, 0)).toBeNull();
  });
});
