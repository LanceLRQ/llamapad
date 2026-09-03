import { describe, expect, it } from "vitest";
import { buildRows, applyTaskUpdate, canSubmit, groupKey, type AcquireRow } from "./acquire-plan";
import type { GroupMatch } from "./acquire-match";

const candidate = {
  absPath: "/host-models/loose/Q4_K_M.gguf", rel: "loose/Q4_K_M.gguf", size: 2600,
  fullSha256: null, inRepoDir: null, inModelsRoot: true,
  hostPath: "/mnt/data/models/loose/Q4_K_M.gguf",
};
// 一行 = 一个量化组；组内 files 是实际执行的单位
const match: GroupMatch = {
  quant: "Q4_K_M", kind: "model",
  files: [{ file: "Q4_K_M.gguf", candidate, actions: ["download", "move", "link"], defaultAction: "move", restriction: "none" }],
  actions: ["download", "move", "link"], defaultAction: "move", restriction: "none",
};

describe("buildRows", () => {
  it("按 defaultAction 预选动作", () => {
    expect(buildRows([match])[0]!.action).toBe("move");
  });

  it("无候选的组固定 download 且动作不可改", () => {
    const none: GroupMatch = {
      ...match,
      files: [{ file: "Q4_K_M.gguf", candidate: null, actions: ["download"], defaultAction: "download", restriction: "none" }],
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
        { file: "m-00001-of-00002.gguf", candidate, actions: ["download", "move"], defaultAction: "move", restriction: "none" },
        { file: "m-00002-of-00002.gguf", candidate, actions: ["download", "move"], defaultAction: "move", restriction: "none" },
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

  it("失败且 error 含内容不符时，行退回可改为下载", () => {
    const rows = buildRows([match]);
    const next = applyTaskUpdate(rows, [{ file: "Q4_K_M.gguf", status: "failed", error: "内容不符：期望 sha256 …", downloadedBytes: 0, totalBytes: 2600 }]);
    expect(next[0]!.phase).toBe("failed");
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
        { file: "m-00001-of-00002.gguf", candidate, actions: ["download", "move"], defaultAction: "move", restriction: "none" },
        { file: "m-00002-of-00002.gguf", candidate, actions: ["download", "move"], defaultAction: "move", restriction: "none" },
      ],
      actions: ["download", "move"],
    };
    const rows = buildRows([twoShards]);
    // 另一片的任务推送迟迟不来——只按已到达的这一片折算进度，不能拿 2600 当分母
    const next = applyTaskUpdate(rows, [{ file: "m-00001-of-00002.gguf", status: "downloading", downloadedBytes: 500, totalBytes: 2600 }]);
    expect(next[0]!.phase).toBe("executing");
    expect(next[0]!.progress).toBeCloseTo(500 / 2600);
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
});

describe("groupKey", () => {
  it("两组 quant 都是 null 时 key 不相撞——身份靠文件名而非 quant", () => {
    const rowA: Pick<AcquireRow, "kind" | "files"> = {
      kind: "model",
      files: [{ file: "a.gguf", candidate: null, actions: ["download"], defaultAction: "download", restriction: "none" }],
    };
    const rowB: Pick<AcquireRow, "kind" | "files"> = {
      kind: "model",
      files: [{ file: "b.gguf", candidate: null, actions: ["download"], defaultAction: "download", restriction: "none" }],
    };
    expect(groupKey(rowA)).not.toBe(groupKey(rowB));
  });
});
