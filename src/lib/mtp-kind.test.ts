import { describe, expect, it } from "vitest";

import { resolveMtpKind } from "./mtp-kind";

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
