import { describe, expect, it } from "vitest";

import { resolveMtpKind, resolveMtpNotice } from "./mtp-kind";

/** 造一个只含判定所需字段的最小 meta；splitTensorsTotal 默认 null（非分片文件的常态） */
const meta = (
  tensorCount: number | null,
  nextn: number | null,
  blockCount: number | null = 65,
  splitTensorsTotal: number | null = null,
) =>
  ({ tensorCount, nextnPredictLayers: nextn, blockCount, splitTensorsTotal }) as Parameters<
    typeof resolveMtpKind
  >[0];

describe("resolveMtpKind", () => {
  it("没有 nextn 键 → none（Qwen3.8-27B-Heretic 实测：851 张量 / 64 层 / 无该键）", () => {
    expect(resolveMtpKind(meta(851, null, 64))).toBe("none");
  });

  it("nextn 为 0 视同没有", () => {
    expect(resolveMtpKind(meta(851, 0, 64))).toBe("none");
  });

  it("张量数远少于层数所需 → sidecar（mtp-Qwen3.8-27B-Q4_0 实测：18 张量 / 65 层）", () => {
    expect(resolveMtpKind(meta(18, 1, 65))).toBe("sidecar");
  });

  it("张量数与层数匹配 → embedded（UD-Q4_K_XL 实测：866 张量 / 65 层）", () => {
    expect(resolveMtpKind(meta(866, 1, 65))).toBe("embedded");
  });

  it("另一个内嵌型样本：Native-MTP-Preserved 实测 753 张量 / 41 层", () => {
    expect(resolveMtpKind(meta(753, 1, 41))).toBe("embedded");
  });

  it("blockCount 缺失时退化为张量数绝对值判定", () => {
    expect(resolveMtpKind(meta(18, 1, null))).toBe("sidecar");
    expect(resolveMtpKind(meta(866, 1, null))).toBe("embedded");
  });

  it("blockCount 为 0 时不做除法（避免 Infinity），同样退化", () => {
    expect(resolveMtpKind(meta(18, 1, 0))).toBe("sidecar");
  });

  it("tensorCount 缺失时无法判定挂件与否，保守当 embedded——有 nextn 就允许开开关", () => {
    expect(resolveMtpKind(meta(null, 1, 65))).toBe("embedded");
  });

  it("分片模型优先用 split.tensors.count 总数，不能用本片 tensor_count 判——GLM-5.3 " +
    "BF16 实测 33 片，第一片 95 张量 / 79 层 = 1.20 会误判 sidecar，总数 1809 / 79 = 22.9 才对", () => {
    expect(resolveMtpKind(meta(95, 1, 79, 1809))).toBe("embedded");
  });

  it("非分片文件没有 split.tensors.count（为 null），回落本片 tensor_count", () => {
    expect(resolveMtpKind(meta(866, 1, 65, null))).toBe("embedded");
  });

  it("sidecar 不受 splitTensorsTotal 字段影响（本身也没有该键）", () => {
    expect(resolveMtpKind(meta(18, 1, 65, null))).toBe("sidecar");
  });
});

/**
 * resolveMtpNotice：MTP 开关放开可用性判定后的提示矩阵。
 *
 * 实测出处：`unsloth/Qwen3.8-27B-GGUF` 的 `Qwen3.8-27B-UD-IQ1_S.gguf`
 * （851 张量 / 64 层 / nextn=0，判定 none）配上 `MTP/mtp-Qwen3.8-27B-Q4_0.gguf`
 * 这个 sidecar，在 `ghcr.io/ggml-org/llama.cpp:server-cuda13` 上实跑：
 * 基线（不开 MTP）55.6 / 55.8 tok/s → 开 MTP 后 68.8 / 70.2 tok/s，提速约 1.25 倍
 * （draft_n=118→accepted=67，接受率约 58%）。这推翻了「none 时置灰」的原设计假设——
 * sidecar 的正当用途正是给 none 权重补 MTP 头。
 */
describe("resolveMtpNotice", () => {
  it("sidecar 永远给 isSidecar 警告，不受开关与 draft 状态影响", () => {
    expect(resolveMtpNotice({ mtpKind: "sidecar", specType: "none", hasDraftFile: false })).toEqual({
      kind: "warn",
      message: "isSidecar",
    });
    expect(resolveMtpNotice({ mtpKind: "sidecar", specType: "draft-mtp", hasDraftFile: true })).toEqual({
      kind: "warn",
      message: "isSidecar",
    });
  });

  it("none + draft-mtp + 无 draft → needsDraft 警告（对应实测里的 IQ1_S 场景）", () => {
    expect(resolveMtpNotice({ mtpKind: "none", specType: "draft-mtp", hasDraftFile: false })).toEqual({
      kind: "warn",
      message: "needsDraft",
    });
  });

  it("none + draft-mtp + 有 draft → 不警告（实测跑通的组合，55.6→69.5 tok/s）", () => {
    expect(resolveMtpNotice({ mtpKind: "none", specType: "draft-mtp", hasDraftFile: true })).toEqual({
      kind: "none",
    });
  });

  it("embedded + draft-mtp + 无 draft → info/embedded（正常用法，非警告）", () => {
    expect(resolveMtpNotice({ mtpKind: "embedded", specType: "draft-mtp", hasDraftFile: false })).toEqual({
      kind: "info",
      message: "embedded",
    });
  });

  it("embedded + draft-mtp + 有 draft → 不警告（多余但无害，llama.cpp 用外挂那份）", () => {
    expect(resolveMtpNotice({ mtpKind: "embedded", specType: "draft-mtp", hasDraftFile: true })).toEqual({
      kind: "none",
    });
  });

  it("任意形态 + specType none + 有 draft → draftWithoutSwitch 警告", () => {
    expect(resolveMtpNotice({ mtpKind: "none", specType: "none", hasDraftFile: true })).toEqual({
      kind: "warn",
      message: "draftWithoutSwitch",
    });
    expect(resolveMtpNotice({ mtpKind: "embedded", specType: "none", hasDraftFile: true })).toEqual({
      kind: "warn",
      message: "draftWithoutSwitch",
    });
  });

  it("任意形态 + specType none + 无 draft → 不警告", () => {
    expect(resolveMtpNotice({ mtpKind: "none", specType: "none", hasDraftFile: false })).toEqual({
      kind: "none",
    });
    expect(resolveMtpNotice({ mtpKind: "embedded", specType: "none", hasDraftFile: false })).toEqual({
      kind: "none",
    });
  });

  it("mtpKind: null（新建/克隆页未解析）+ draft-mtp → 不警告，无论 draft 是否存在", () => {
    expect(resolveMtpNotice({ mtpKind: null, specType: "draft-mtp", hasDraftFile: false })).toEqual({
      kind: "none",
    });
    expect(resolveMtpNotice({ mtpKind: null, specType: "draft-mtp", hasDraftFile: true })).toEqual({
      kind: "none",
    });
  });

  it("mtpKind: null + specType none + 有 draft → draftWithoutSwitch 仍生效（唯一例外）", () => {
    expect(resolveMtpNotice({ mtpKind: null, specType: "none", hasDraftFile: true })).toEqual({
      kind: "warn",
      message: "draftWithoutSwitch",
    });
  });

  it("mtpKind: null + specType none + 无 draft → 不警告", () => {
    expect(resolveMtpNotice({ mtpKind: null, specType: "none", hasDraftFile: false })).toEqual({
      kind: "none",
    });
  });
});
