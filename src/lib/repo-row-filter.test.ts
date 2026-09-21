import { describe, expect, it } from "vitest";
import { collectQuantTiers, quantTier, visibleRepoRowIndices } from "./repo-row-filter";
import type { RepoRow } from "./repo-files-view";

function row(overrides: Partial<RepoRow>): RepoRow {
  return {
    quant: null,
    kind: "model",
    mtpKind: "none",
    files: [],
    totalSize: 0,
    state: "present",
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
    ...overrides,
  };
}

describe("quantTier", () => {
  it("null 归为未识别", () => {
    expect(quantTier(null)).toBeNull();
  });

  it("Qx_K_M / Qx_K_S 归入同一位宽档位", () => {
    expect(quantTier("Q4_K_M")).toBe("Q4");
    expect(quantTier("Q4_K_S")).toBe("Q4");
  });

  it("IQ 系列按同位宽归档", () => {
    expect(quantTier("IQ4_XS")).toBe("Q4");
  });

  it("Q8_0 / Q2_K 按数字归档", () => {
    expect(quantTier("Q8_0")).toBe("Q8");
    expect(quantTier("Q2_K")).toBe("Q2");
  });

  it("非 Qx 标签原样大写返回", () => {
    expect(quantTier("f16")).toBe("F16");
    expect(quantTier("bf16")).toBe("BF16");
    expect(quantTier("F32")).toBe("F32");
  });
});

describe("collectQuantTiers", () => {
  it("按 Q<n> 升序排在前，其余按字典序排在后，且去重", () => {
    const rows = [
      row({ quant: "Q8_0" }),
      row({ quant: "Q4_K_M" }),
      row({ quant: "Q4_K_S" }),
      row({ quant: "F16" }),
      row({ quant: "BF16" }),
    ];
    expect(collectQuantTiers(rows, null)).toEqual(["Q4", "Q8", "BF16", "F16"]);
  });

  it("辅助行（mmproj）不进选项", () => {
    const rows = [row({ quant: "Q4_K_M" }), row({ quant: "Q4_K_M", kind: "mmproj" })];
    expect(collectQuantTiers(rows, null)).toEqual(["Q4"]);
  });

  it("辅助行（MTP 目录，仅靠 remoteGroups 回填的目录名判定，文件名本身不带 mtp 字样）不进选项", () => {
    // RepoRow.files 在生产里已被 mergeRepoRows 收窄成 basename（不带目录），
    // MTP 判定必须靠 remoteGroups 回填的完整路径才能看到 "MTP/" 这一段——
    // 这里刻意让 basename 本身不含 "mtp"，逼着实现真的走回填这条路，
    // 不能靠夹具里文件名自带 mtp 字样蒙混过关
    const rows = [
      row({ quant: "Q4_K_M", files: ["model-Q4_K_M.gguf"] }),
      row({ quant: "Q6_K", files: ["model-Q6_K.gguf"] }),
    ];
    const remoteGroups = [
      { files: [{ path: "model-Q4_K_M.gguf" }] },
      { files: [{ path: "MTP/model-Q6_K.gguf" }] },
    ];
    expect(collectQuantTiers(rows, remoteGroups)).toEqual(["Q4"]);
  });

  it("未识别档位不产生选项", () => {
    const rows = [row({ quant: "Q4_K_M" }), row({ quant: null })];
    expect(collectQuantTiers(rows, null)).toEqual(["Q4"]);
  });
});

describe("visibleRepoRowIndices", () => {
  const rows: RepoRow[] = [
    row({ quant: "Q4_K_M", files: ["model-Q4_K_M.gguf"] }),
    row({ quant: "Q5_K_M", files: ["model-Q5_K_M.gguf"] }),
    row({ quant: "Q4_K_M", kind: "mmproj", files: ["mmproj-f16.gguf"] }),
    // 文件名本身不带 mtp 字样，MTP 归类必须靠下方 remoteGroups 回填的 "MTP/"
    // 目录段才能判出来——不能靠 basename 蒙混过关（复核 Important 项同一条件）
    row({ quant: "Q4_K_M", files: ["draft-Q4_K_M.gguf"] }),
    row({ quant: null, files: ["weird.gguf"] }),
  ];
  const remoteGroups = [
    { files: [{ path: "sub/model-Q4_K_M.gguf" }] },
    { files: [{ path: "model-Q5_K_M.gguf" }] },
    { files: [{ path: "mmproj-f16.gguf" }] },
    { files: [{ path: "MTP/draft-Q4_K_M.gguf" }] },
    { files: [{ path: "weird.gguf" }] },
  ];

  it("空 query 空 tiers 全部可见", () => {
    const visible = visibleRepoRowIndices({ rows, remoteGroups, query: "", tiers: [] });
    expect(visible).toEqual(new Set([0, 1, 2, 3, 4]));
  });

  it("搜索大小写不敏感，且能匹配目录段", () => {
    const visible = visibleRepoRowIndices({ rows, remoteGroups, query: "SUB", tiers: [] });
    expect(visible).toEqual(new Set([0]));
  });

  it("搜索匹配文件名本身", () => {
    const visible = visibleRepoRowIndices({ rows, remoteGroups, query: "q5_k_m", tiers: [] });
    expect(visible).toEqual(new Set([1]));
  });

  it("选了 Q5 时 mmproj 与 MTP 行仍然可见", () => {
    const visible = visibleRepoRowIndices({ rows, remoteGroups, query: "", tiers: ["Q5"] });
    expect(visible).toEqual(new Set([1, 2, 3]));
  });

  it("未识别行在有档位筛选时被过滤掉", () => {
    const visible = visibleRepoRowIndices({ rows, remoteGroups, query: "", tiers: ["Q4"] });
    expect(visible.has(4)).toBe(false);
    expect(visible).toEqual(new Set([0, 2, 3]));
  });

  it("搜索与档位筛选是与的关系", () => {
    const visible = visibleRepoRowIndices({ rows, remoteGroups, query: "Q4_K_M", tiers: ["Q4"] });
    // Q4 档位放行 0（主权重）与 3（MTP 辅助行豁免），mmproj/Q5 文件名不含 "Q4_K_M" 被搜索挡掉
    expect(visible).toEqual(new Set([0, 3]));
  });

  it("remoteGroups 为 null 时按行内 files 判定（无目录可回填）", () => {
    const visible = visibleRepoRowIndices({ rows, remoteGroups: null, query: "mmproj", tiers: [] });
    expect(visible).toEqual(new Set([2]));
  });
});
