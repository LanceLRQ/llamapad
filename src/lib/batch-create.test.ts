import { describe, expect, it } from "vitest";

import {
  archiveMmprojFile,
  batchCreateCandidates,
  buildCreateModelBody,
  classifyCreateResult,
} from "./batch-create";
import type { RepoRow } from "./repo-files-view";

function makeRow(overrides: Partial<RepoRow> = {}): RepoRow {
  return {
    quant: "Q4_K_M",
    kind: "model",
    files: ["Q4_K_M.gguf"],
    totalSize: 100,
    state: "present",
    progress: null,
    haveShards: 1,
    totalShards: 1,
    strayRels: [],
    relocatableRels: [],
    strayRepoDirs: [],
    driftStrays: [],
    models: [],
    localRels: ["hf/o/r/Q4_K_M.gguf"],
    sharedWith: [],
    taskStatus: null,
    hasUpdate: false,
    unverified: false,
    localSize: null,
    remoteSize: null,
    ...overrides,
  };
}

describe("batchCreateCandidates", () => {
  it("present 且无配置引用的模型行入选", () => {
    const candidates = batchCreateCandidates("o/r-GGUF", [makeRow()]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.name).toBe("r-q4-k-m");
    expect(candidates[0]!.displayName).toBe("r (Q4_K_M)");
    expect(candidates[0]!.ggufFile).toBe("hf/o/r/Q4_K_M.gguf");
  });

  it("已被配置引用的行不入选", () => {
    const candidates = batchCreateCandidates("o/r-GGUF", [makeRow({ models: ["existing"] })]);
    expect(candidates).toHaveLength(0);
  });

  it("未下载完整的行不入选", () => {
    const candidates = batchCreateCandidates("o/r-GGUF", [makeRow({ state: "partial" })]);
    expect(candidates).toHaveLength(0);
  });

  it("mmproj 分组不入选——它是挂件不是独立模型", () => {
    const candidates = batchCreateCandidates("o/r-GGUF", [
      makeRow({ kind: "mmproj", files: ["mmproj-F16.gguf"], localRels: ["hf/o/r/mmproj-F16.gguf"] }),
    ]);
    expect(candidates).toHaveLength(0);
  });

  it("量化未识别（quant 为 null）时只用仓库基名预填", () => {
    const candidates = batchCreateCandidates("o/r-GGUF", [
      makeRow({ quant: null, files: ["weird.gguf"], localRels: ["hf/o/r/weird.gguf"] }),
    ]);
    expect(candidates[0]!.name).toBe("r");
    expect(candidates[0]!.displayName).toBe("r");
  });

  it("分片组按首片文件名算出 glob 前缀", () => {
    const candidates = batchCreateCandidates("o/r-GGUF", [
      makeRow({
        files: ["m-00001-of-00002.gguf", "m-00002-of-00002.gguf"],
        localRels: ["hf/o/r/m-00001-of-00002.gguf"],
        haveShards: 2,
        totalShards: 2,
      }),
    ]);
    expect(candidates[0]!.ggufFile).toBe("hf/o/r/m-*.gguf");
  });

  it("present 但本地路径缺失（理论上不该发生）时不入选，避免生成无法提交的行", () => {
    const candidates = batchCreateCandidates("o/r-GGUF", [makeRow({ localRels: [] })]);
    expect(candidates).toHaveLength(0);
  });

  it("多行保持原有顺序", () => {
    const candidates = batchCreateCandidates("o/r-GGUF", [
      makeRow({ quant: "Q4_K_M", files: ["a.gguf"], localRels: ["hf/o/r/a.gguf"] }),
      makeRow({ quant: "Q8_0", files: ["b.gguf"], localRels: ["hf/o/r/b.gguf"] }),
    ]);
    expect(candidates.map((c) => c.quant)).toEqual(["Q4_K_M", "Q8_0"]);
  });
});

describe("archiveMmprojFile", () => {
  it("没有 present 的 mmproj 组时返回 null", () => {
    expect(archiveMmprojFile([makeRow()])).toBeNull();
  });

  it("mmproj 组存在但未下载完整时返回 null", () => {
    const rows = [makeRow(), makeRow({ kind: "mmproj", state: "partial", localRels: [] })];
    expect(archiveMmprojFile(rows)).toBeNull();
  });

  it("mmproj 组已下载完整时返回其路径", () => {
    const rows = [
      makeRow(),
      makeRow({
        kind: "mmproj",
        quant: null,
        files: ["mmproj-F16.gguf"],
        localRels: ["hf/o/r/mmproj-F16.gguf"],
      }),
    ];
    expect(archiveMmprojFile(rows)).toBe("hf/o/r/mmproj-F16.gguf");
  });
});

describe("buildCreateModelBody", () => {
  const candidate = { ggufFile: "hf/o/r/Q4_K_M.gguf" };

  it("不带 mmprojFile 时请求体不含 mmproj_file 字段", () => {
    const body = buildCreateModelBody(candidate, {
      name: "r-q4-k-m",
      displayName: "R (Q4_K_M)",
      namespace: "main",
      mmprojFile: null,
    });
    expect(body).toEqual({
      name: "r-q4-k-m",
      display_name: "R (Q4_K_M)",
      namespace: "main",
      gguf_file: "hf/o/r/Q4_K_M.gguf",
    });
    expect(body).not.toHaveProperty("mmproj_file");
  });

  it("勾选附加 mmproj 时带上 mmproj_file", () => {
    const body = buildCreateModelBody(candidate, {
      name: "r-q4-k-m",
      displayName: "R (Q4_K_M)",
      namespace: "main",
      mmprojFile: "hf/o/r/mmproj-F16.gguf",
    });
    expect(body.mmproj_file).toBe("hf/o/r/mmproj-F16.gguf");
  });

  it("不传 overrides——由 schema 的 prefault 生效走全局默认参数", () => {
    const body = buildCreateModelBody(candidate, {
      name: "r",
      displayName: "R",
      namespace: "main",
      mmprojFile: null,
    });
    expect(body).not.toHaveProperty("overrides");
  });

  it("首尾空白裁剪；显示名留空时回退成模型名", () => {
    const body = buildCreateModelBody(candidate, {
      name: "  r-q4-k-m  ",
      displayName: "   ",
      namespace: "main",
      mmprojFile: null,
    });
    expect(body.name).toBe("r-q4-k-m");
    expect(body.display_name).toBe("r-q4-k-m");
  });
});

describe("buildCreateModelBody 的 overrides", () => {
  const candidate = { ggufFile: "hf/o/r/model.gguf" };
  const input = { name: "m", displayName: "M", namespace: "main", mmprojFile: null };

  it("不传 overrides 时请求体里没有这个键（保持既有决策：走全局默认）", () => {
    expect(buildCreateModelBody(candidate, input)).not.toHaveProperty("overrides");
  });

  it("传了非空 server 时写进 overrides.server", () => {
    const body = buildCreateModelBody(candidate, { ...input, server: { temp: 0.6, top_p: 0.95 } });
    expect(body.overrides).toEqual({ server: { temp: 0.6, top_p: 0.95 } });
  });

  it("传了空对象等同于不传 —— 空 overrides 会在配置里留下一个无意义的空壳", () => {
    expect(buildCreateModelBody(candidate, { ...input, server: {} })).not.toHaveProperty("overrides");
  });

  it("overrides 不影响其余字段", () => {
    const body = buildCreateModelBody(candidate, { ...input, server: { temp: 1 } });
    expect(body.name).toBe("m");
    expect(body.gguf_file).toBe("hf/o/r/model.gguf");
  });
});

describe("classifyCreateResult", () => {
  it("201 → success", () => {
    expect(classifyCreateResult(201)).toBe("success");
  });

  it("409 → conflict（名字冲突，该行标红继续跑）", () => {
    expect(classifyCreateResult(409)).toBe("conflict");
  });

  it("400/500 → stop（系统性问题，整批停下）", () => {
    expect(classifyCreateResult(400)).toBe("stop");
    expect(classifyCreateResult(500)).toBe("stop");
  });

  it("网络中断（null）→ stop", () => {
    expect(classifyCreateResult(null)).toBe("stop");
  });
});
