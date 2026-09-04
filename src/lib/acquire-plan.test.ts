import { describe, expect, it } from "vitest";
import {
  applyTaskUpdate,
  buildAcquireSubmitItems,
  buildRows,
  canSubmit,
  groupKey,
  hasExecutingRow,
  isRowEditable,
  matchScannedGroups,
  type AcquireRow,
} from "./acquire-plan";
import type { GroupMatch } from "./acquire-match";

const candidate = {
  absPath: "/host-models/loose/Q4_K_M.gguf", rel: "loose/Q4_K_M.gguf", size: 2600,
  fullSha256: null, inRepoDir: null, inModelsRoot: true,
  hostPath: "/mnt/data/models/loose/Q4_K_M.gguf", referenced: false,
};
// 一行 = 一个量化组；组内 files 是实际执行的单位
const match: GroupMatch = {
  quant: "Q4_K_M", kind: "model",
  files: [{ file: "Q4_K_M.gguf", candidate, drift: "same", actions: ["download", "move", "link"], defaultAction: "move", restriction: "none" }],
  actions: ["download", "move", "link"], defaultAction: "move", restriction: "none",
};
// 第二组：与 match 身份不同（quant 不同），用于混合批次（部分 done + 部分
// failed）与 matchScannedGroups 的多组匹配测试
const match2: GroupMatch = {
  quant: "Q8_0", kind: "model",
  files: [{ file: "Q8_0.gguf", candidate: null, drift: null, actions: ["download"], defaultAction: "download", restriction: "none" }],
  actions: ["download"], defaultAction: "download", restriction: "none",
};

describe("buildRows", () => {
  it("按 defaultAction 预选动作", () => {
    expect(buildRows([match])[0]!.action).toBe("move");
  });

  it("无候选的组固定 download 且动作不可改", () => {
    const none: GroupMatch = {
      ...match,
      files: [{ file: "Q4_K_M.gguf", candidate: null, drift: null, actions: ["download"], defaultAction: "download", restriction: "none" }],
      actions: ["download"], defaultAction: "download",
    };
    const rows = buildRows([none]);
    expect(rows[0]!.action).toBe("download");
    expect(rows[0]!.actions).toEqual(["download"]);
  });

  it("组内多个文件时行只有一行，files 全带上——提交时逐个文件发给 acquire", () => {
    const twoShards: GroupMatch = {
      ...match,
      files: [
        { file: "m-00001-of-00002.gguf", candidate, drift: "same", actions: ["download", "move"], defaultAction: "move", restriction: "none" },
        { file: "m-00002-of-00002.gguf", candidate, drift: "same", actions: ["download", "move"], defaultAction: "move", restriction: "none" },
      ],
      actions: ["download", "move"],
    };
    const rows = buildRows([twoShards]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.files).toHaveLength(2);
  });
});

describe("applyTaskUpdate", () => {
  it("下载中的任务把行推进到 executing 并带进度", () => {
    const rows = buildRows([match]);
    const next = applyTaskUpdate(rows, [{ file: "Q4_K_M.gguf", status: "downloading", downloadedBytes: 1300, totalBytes: 2600 }]);
    expect(next[0]!.phase).toBe("executing");
    expect(next[0]!.progress).toBeCloseTo(0.5);
  });

  it("失败时行退回可改为下载——与错误文本无关，只要不是本就在下载", () => {
    const rows = buildRows([match]);
    const next = applyTaskUpdate(rows, [{ file: "Q4_K_M.gguf", status: "failed", error: "内容不符：期望 sha256 …", downloadedBytes: 0, totalBytes: 2600 }]);
    expect(next[0]!.phase).toBe("failed");
    expect(next[0]!.canFallbackToDownload).toBe(true);
  });

  it("失败原因换成别的文本（非内容不符）时同样可回退——canFallbackToDownload 不看 error 文本", () => {
    const rows = buildRows([match]);
    const next = applyTaskUpdate(rows, [{ file: "Q4_K_M.gguf", status: "failed", error: "磁盘空间不足", downloadedBytes: 0, totalBytes: 2600 }]);
    expect(next[0]!.canFallbackToDownload).toBe(true);
  });

  it("完成的行进入 done", () => {
    const rows = buildRows([match]);
    const next = applyTaskUpdate(rows, [{ file: "Q4_K_M.gguf", status: "completed", downloadedBytes: 2600, totalBytes: 2600 }]);
    expect(next[0]!.phase).toBe("done");
    expect(next[0]!.progress).toBe(1);
  });

  it("多文件组只有一片任务推送到达时，行进入 executing 而非误判 done", () => {
    const twoShards: GroupMatch = {
      ...match,
      files: [
        { file: "m-00001-of-00002.gguf", candidate, drift: "same", actions: ["download", "move"], defaultAction: "move", restriction: "none" },
        { file: "m-00002-of-00002.gguf", candidate, drift: "same", actions: ["download", "move"], defaultAction: "move", restriction: "none" },
      ],
      actions: ["download", "move"],
    };
    const rows = buildRows([twoShards]);
    // 另一片的任务推送迟迟不来——按「已到达的这一片自身的字节占比 × 已到达文件数/组内
    // 文件数」折算，不能拿单片的 2600 当整组分母（那会算出比真实进度更高的数字）
    const next = applyTaskUpdate(rows, [{ file: "m-00001-of-00002.gguf", status: "downloading", downloadedBytes: 500, totalBytes: 2600 }]);
    expect(next[0]!.phase).toBe("executing");
    expect(next[0]!.progress).toBeCloseTo((500 / 2600) * (1 / 2));
  });

  it("一片已 100% 完成、另一片还没消息时，组进度不能虚高到 1", () => {
    const twoShards: GroupMatch = {
      ...match,
      files: [
        { file: "m-00001-of-00002.gguf", candidate, drift: "same", actions: ["download", "move"], defaultAction: "move", restriction: "none" },
        { file: "m-00002-of-00002.gguf", candidate, drift: "same", actions: ["download", "move"], defaultAction: "move", restriction: "none" },
      ],
      actions: ["download", "move"],
    };
    const rows = buildRows([twoShards]);
    // 只有第一片报过来，且它自己的 downloaded === total——如果只看这一片的字节比例
    // 会算出 100%，但组里还有一片完全没消息，真实进度应该在一半左右
    const next = applyTaskUpdate(rows, [{ file: "m-00001-of-00002.gguf", status: "downloading", downloadedBytes: 1300, totalBytes: 1300 }]);
    expect(next[0]!.phase).toBe("executing");
    expect(next[0]!.progress).toBeCloseTo(0.5);
  });

  // C1：入队时被跳过的文件（目标已存在且大小匹配）没有任务行，永远等不到推送。
  // 不把它们算作已到达，「3 分片已存在 2 片」的组会永远卡在 executing
  it("组内 2 片在 skipped 名单里、第 3 片 completed → 整组 done", () => {
    const threeShards: GroupMatch = {
      ...match,
      files: [
        { file: "m-00001-of-00003.gguf", candidate, drift: "same", actions: ["download", "move"], defaultAction: "move", restriction: "none" },
        { file: "m-00002-of-00003.gguf", candidate, drift: "same", actions: ["download", "move"], defaultAction: "move", restriction: "none" },
        { file: "m-00003-of-00003.gguf", candidate, drift: "same", actions: ["download", "move"], defaultAction: "move", restriction: "none" },
      ],
      actions: ["download", "move"],
    };
    const rows = buildRows([threeShards]);
    const next = applyTaskUpdate(
      rows,
      [{ file: "m-00003-of-00003.gguf", status: "completed", downloadedBytes: 900, totalBytes: 900 }],
      ["m-00001-of-00003.gguf", "m-00002-of-00003.gguf"],
    );
    expect(next[0]!.phase).toBe("done");
    expect(next[0]!.progress).toBe(1);
  });

  it("整组都在 skipped 名单里时无需任何推送即可 done——那些文件压根没有任务", () => {
    const rows = buildRows([match]);
    const next = applyTaskUpdate(rows, [], ["Q4_K_M.gguf"]);
    expect(next[0]!.phase).toBe("done");
  });

  it("被跳过的分片按整片完成计入进度，另一片进行中", () => {
    const twoShards: GroupMatch = {
      ...match,
      files: [
        { file: "m-00001-of-00002.gguf", candidate, drift: "same", actions: ["download", "move"], defaultAction: "move", restriction: "none" },
        { file: "m-00002-of-00002.gguf", candidate, drift: "same", actions: ["download", "move"], defaultAction: "move", restriction: "none" },
      ],
      actions: ["download", "move"],
    };
    const rows = buildRows([twoShards]);
    const next = applyTaskUpdate(
      rows,
      [{ file: "m-00002-of-00002.gguf", status: "downloading", downloadedBytes: 650, totalBytes: 1300 }],
      ["m-00001-of-00002.gguf"],
    );
    expect(next[0]!.phase).toBe("executing");
    expect(next[0]!.progress).toBeCloseTo((1 + 0.5) / 2);
  });

  it("skipped 名单为空时行为与既有一致（默认参数同样不影响）", () => {
    const rows = buildRows([match]);
    const withEmpty = applyTaskUpdate(rows, [{ file: "Q4_K_M.gguf", status: "downloading", downloadedBytes: 1300, totalBytes: 2600 }], []);
    const withoutArg = applyTaskUpdate(rows, [{ file: "Q4_K_M.gguf", status: "downloading", downloadedBytes: 1300, totalBytes: 2600 }]);
    expect(withEmpty).toEqual(withoutArg);
    expect(withEmpty[0]!.phase).toBe("executing");
    expect(withEmpty[0]!.progress).toBeCloseTo(0.5);
  });

  it("不属于本行的 skipped 文件名不影响该行（按文件名对齐，不是全局开关）", () => {
    const rows = buildRows([match, match2]);
    const next = applyTaskUpdate(rows, [], ["Q8_0.gguf"]);
    expect(next[0]!.phase).toBe("idle"); // Q4_K_M 组没被跳过，仍未提交
    expect(next[1]!.phase).toBe("done");
  });
});

describe("canSubmit", () => {
  it("全是 idle 时可提交", () => {
    expect(canSubmit(buildRows([match]))).toBe(true);
  });

  it("有行在执行中时不可重复提交", () => {
    const rows = buildRows([match]).map((r) => ({ ...r, phase: "executing" as const }));
    expect(canSubmit(rows)).toBe(false);
  });

  // 复核修复：done 不再拖累其余行——旧版本 rows.every(isRowEditable) 会让
  // 一批里只要有一行成功，其余失败行改完动作也永远交不出去
  it("全 done 时不可提交——没什么好交的", () => {
    const rows = buildRows([match]).map((r) => ({ ...r, phase: "done" as const }));
    expect(canSubmit(rows)).toBe(false);
  });

  it("部分 done + 部分 failed 时可提交——失败的那些还能重试", () => {
    const rows = buildRows([match, match2]);
    rows[0] = { ...rows[0]!, phase: "done" };
    rows[1] = { ...rows[1]!, phase: "failed" };
    expect(canSubmit(rows)).toBe(true);
  });

  it("空数组不可提交", () => {
    expect(canSubmit([])).toBe(false);
  });
});

describe("isRowEditable", () => {
  it("idle 和 failed 可编辑，executing 和 done 不可编辑——四态各自的期望", () => {
    expect(isRowEditable({ phase: "idle" })).toBe(true);
    expect(isRowEditable({ phase: "failed" })).toBe(true);
    expect(isRowEditable({ phase: "executing" })).toBe(false);
    expect(isRowEditable({ phase: "done" })).toBe(false);
  });
});

describe("hasExecutingRow", () => {
  it("没有行在执行中时为 false", () => {
    expect(hasExecutingRow(buildRows([match]))).toBe(false);
  });

  it("有行在执行中时为 true——用于拦截弹层中途关闭", () => {
    const rows = buildRows([match]).map((r) => ({ ...r, phase: "executing" as const }));
    expect(hasExecutingRow(rows)).toBe(true);
  });

  it("done/failed 都不算执行中", () => {
    const done = buildRows([match]).map((r) => ({ ...r, phase: "done" as const }));
    const failed = buildRows([match]).map((r) => ({ ...r, phase: "failed" as const }));
    expect(hasExecutingRow(done)).toBe(false);
    expect(hasExecutingRow(failed)).toBe(false);
  });
});

describe("matchScannedGroups", () => {
  it("按 (quant, kind) 匹配，不看数组下标", () => {
    // 深度扫描的分组顺序与档案页常规扫描不必一致——这里故意让 groups 与
    // picked 的顺序相反，验证匹配确实靠身份而不是下标对齐
    const picked = [{ quant: "Q8_0", kind: "model" as const }];
    expect(matchScannedGroups(picked, [match, match2])).toEqual([match2]);
  });

  it("勾了多组时全部带出", () => {
    const picked = [
      { quant: "Q4_K_M", kind: "model" as const },
      { quant: "Q8_0", kind: "model" as const },
    ];
    expect(matchScannedGroups(picked, [match, match2])).toEqual([match, match2]);
  });

  it("没勾中的组不带出", () => {
    const picked = [{ quant: "Q4_K_M", kind: "model" as const }];
    expect(matchScannedGroups(picked, [match, match2])).toEqual([match]);
  });

  it("kind 不同时不算同一组，即使 quant 相同", () => {
    const mmprojSameQuant: GroupMatch = { ...match, kind: "mmproj" };
    const picked = [{ quant: "Q4_K_M", kind: "mmproj" as const }];
    expect(matchScannedGroups(picked, [match, mmprojSameQuant])).toEqual([mmprojSameQuant]);
  });
});

describe("buildAcquireSubmitItems", () => {
  it("idle 行按组级动作展开成 items，带 sourceHostPath", () => {
    const items = buildAcquireSubmitItems(buildRows([match]));
    expect(items).toEqual([{ file: "Q4_K_M.gguf", action: "move", sourceHostPath: candidate.hostPath }]);
  });

  it("组级动作是 download 时不带 sourceHostPath", () => {
    const items = buildAcquireSubmitItems(buildRows([match2]));
    expect(items).toEqual([{ file: "Q8_0.gguf", action: "download" }]);
  });

  it("混合组：组内没有候选的文件强制降级为 download，其余文件仍按组级动作", () => {
    const mixed: GroupMatch = {
      ...match,
      files: [
        { file: "m-00001-of-00002.gguf", candidate, drift: "same", actions: ["download", "move"], defaultAction: "move", restriction: "none" },
        { file: "m-00002-of-00002.gguf", candidate: null, drift: null, actions: ["download"], defaultAction: "download", restriction: "none" },
      ],
      actions: ["download", "move"],
    };
    const items = buildAcquireSubmitItems(buildRows([mixed]));
    expect(items).toEqual([
      { file: "m-00001-of-00002.gguf", action: "move", sourceHostPath: candidate.hostPath },
      { file: "m-00002-of-00002.gguf", action: "download" },
    ]);
  });

  // 复核修复的核心回归锁：done 行不能被重新提交一遍，否则已成功的文件会
  // 被再搬一次/再下一次
  it("done 行被跳过，不出现在提交 items 里", () => {
    const rows = buildRows([match, match2]);
    rows[0] = { ...rows[0]!, phase: "done" };
    const items = buildAcquireSubmitItems(rows);
    expect(items).toEqual([{ file: "Q8_0.gguf", action: "download" }]);
  });

  it("executing 行也被跳过——理论上不会传进来，这里是防御", () => {
    const rows = buildRows([match]).map((r) => ({ ...r, phase: "executing" as const }));
    expect(buildAcquireSubmitItems(rows)).toEqual([]);
  });

  // 手动关联（规格 §7）：这类行的文件级 actions 恒是 ["download"]（drift 为
  // different，actionsFor 只给下载），组级 actions 才是弹层挑定的那一组。
  // 若沿用「组级 ∧ 文件级」的降级判据，用户挑的动作会被原地降级，逃生口失效
  it("手动关联行：带 manual 与 sourceHostPath，动作不被文件级 actions 降级", () => {
    const manualMatch: GroupMatch = {
      ...match,
      files: [{ file: "Q4_K_M.gguf", candidate, drift: "different", actions: ["download"], defaultAction: "download", restriction: "version-drift" }],
      actions: ["download", "link"],
    };
    const rows = buildRows([manualMatch]).map((r) => ({ ...r, action: "link" as const, manual: true }));
    expect(buildAcquireSubmitItems(rows)).toEqual([
      { file: "Q4_K_M.gguf", action: "link", sourceHostPath: candidate.hostPath, manual: true },
    ]);
  });

  // 服务端 itemSchema 是 strictObject 且 manual 为 z.literal(true).optional()，
  // 带上 manual: false 会让整个请求体被拒——非手动行必须连键都不出现
  it("非手动行不带 manual 键", () => {
    const item = buildAcquireSubmitItems(buildRows([match]))[0]!;
    expect(item).not.toHaveProperty("manual");
  });

  it("手动行的动作若不在组级 actions 里，仍降级为下载（前端不许自造动作）", () => {
    const rows = buildRows([match]).map((r) => ({ ...r, action: "copy" as const, manual: true }));
    expect(buildAcquireSubmitItems(rows)).toEqual([{ file: "Q4_K_M.gguf", action: "download" }]);
  });

  // 降级成 download 之后就不该再带 manual：服务端对 download 动作根本不看
  // 这个字段，带上只会让「这次提交放宽了校验」在事件里留下误导性的痕迹
  it("手动行降级为下载后不带 manual 键", () => {
    const rows = buildRows([match]).map((r) => ({ ...r, action: "copy" as const, manual: true }));
    expect(buildAcquireSubmitItems(rows)[0]!).not.toHaveProperty("manual");
  });

  // I5：降级判据是「这个文件支不支持组级动作」，不是「有没有候选」——候选存在
  // 但远端无 oid 的文件 actions 恒为 ["download"]，被 mergeGroupMatch 排除出
  // basis 后组级动作仍可能是 link，按候选判会给它发 link + sourceHostPath，
  // 服务端 L1 重验必然 MISMATCH 400，整批一条都进不去
  it("组级 link + 组内一个 no-oid 文件（candidate 非 null）→ 该文件降级为 download 且不带 sourceHostPath", () => {
    const inRepoCandidate = { ...candidate, inRepoDir: "hf/other/R" };
    const noOidGroup: GroupMatch = {
      ...match,
      files: [
        { file: "m-00001-of-00002.gguf", candidate: inRepoCandidate, drift: "same", actions: ["download", "link"], defaultAction: "link", restriction: "in-repo" },
        { file: "m-00002-of-00002.gguf", candidate: inRepoCandidate, drift: "same", actions: ["download"], defaultAction: "download", restriction: "no-oid" },
      ],
      actions: ["download", "link"],
      defaultAction: "link",
      restriction: "in-repo",
    };
    const items = buildAcquireSubmitItems(buildRows([noOidGroup]));
    expect(items).toEqual([
      { file: "m-00001-of-00002.gguf", action: "link", sourceHostPath: inRepoCandidate.hostPath },
      { file: "m-00002-of-00002.gguf", action: "download" },
    ]);
  });

  it("组级动作不在组自身的 actions 里（状态被外部改坏）时整组降级为 download，不发出不合法的动作", () => {
    const rows = buildRows([match]).map((r) => ({ ...r, action: "copy" as const }));
    expect(buildAcquireSubmitItems(rows)).toEqual([{ file: "Q4_K_M.gguf", action: "download" }]);
  });

  it("failed 行仍会提交——「改为下载」后要能重新交", () => {
    const rows = buildRows([match]).map((r) => ({ ...r, phase: "failed" as const, action: "download" as const }));
    expect(buildAcquireSubmitItems(rows)).toEqual([{ file: "Q4_K_M.gguf", action: "download" }]);
  });
});

describe("groupKey", () => {
  it("两组 quant 都是 null 时 key 不相撞——身份靠文件名而非 quant", () => {
    const rowA: Pick<AcquireRow, "kind" | "files"> = {
      kind: "model",
      files: [{ file: "a.gguf", candidate: null, drift: null, actions: ["download"], defaultAction: "download", restriction: "none" }],
    };
    const rowB: Pick<AcquireRow, "kind" | "files"> = {
      kind: "model",
      files: [{ file: "b.gguf", candidate: null, drift: null, actions: ["download"], defaultAction: "download", restriction: "none" }],
    };
    expect(groupKey(rowA)).not.toBe(groupKey(rowB));
  });
});
