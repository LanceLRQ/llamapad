import { describe, expect, it } from "vitest";
import { localOnlyRows, mergeRepoRows, retainedSelection, sameQuantIdentity, summarizeRepoRows, type RepoRow, type RepoRowInput, type RepoRowState } from "./repo-files-view";

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
    expect(rows[0].strayRel).toBe("main/Q4_K_M.gguf");
  });

  // I4 回归锁：basename 撞车但大小不等——大概率是另一个仓库的同名文件，
  // 或是没下完的半成品，两种都不该给出「归位」按钮
  it("同名但 size 不等的 stray 不被匹配，行仍是未下载", () => {
    const rows = mergeRepoRows({
      ...base,
      strays: [{ file: "Q4_K_M.gguf", rel: "main/Q4_K_M.gguf", size: 999 }],
    });
    expect(rows[0].state).toBe("absent");
    expect(rows[0].strayRel).toBeNull();
  });

  it("同名且 size 相等的 stray 正常匹配成在别处", () => {
    const rows = mergeRepoRows({
      ...base,
      strays: [{ file: "Q4_K_M.gguf", rel: "main/Q4_K_M.gguf", size: 100 }],
    });
    expect(rows[0].state).toBe("stray");
    expect(rows[0].strayRel).toBe("main/Q4_K_M.gguf");
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
    expect(rows[0].strayRel).toBe("downloads/Q4_K_M.gguf");
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
    expect(rows[0].strayRel).toBeNull();
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
        { file: "m-00002-of-00003.gguf", rel: "main/m-00002-of-00003.gguf", size: 10 },
        { file: "m-00003-of-00003.gguf", rel: "main/m-00003-of-00003.gguf", size: 10 },
      ],
    });
    expect(rows[0].state).toBe("partial");
    expect(rows[0].haveShards).toBe(1);
    expect(rows[0].strayRel).toBe("main/m-00002-of-00003.gguf");
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
    expect(rows[0].strayRel).toBeNull();
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
    strayRel: null,
    models: [],
    localRels: [],
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

  it("身份没变、行变成 stray：剔除", () => {
    const next = retainedSelection(new Set([0]), [row("stray")], true);
    expect(next).toEqual(new Set());
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
