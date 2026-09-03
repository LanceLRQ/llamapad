import { describe, expect, it } from "vitest";
import { isSelectable, localOnlyRows, mergeRepoRows, retainedSelection, sameQuantIdentity, summarizeRepoRows, type RepoRow, type RepoRowInput, type RepoRowState } from "./repo-files-view";

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
    models: [],
    localRels: [],
    sharedWith: [],
    taskStatus: null,
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
