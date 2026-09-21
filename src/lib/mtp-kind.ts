import type { GgufMeta } from "@/core/gguf";

/**
 * 权重的 MTP 形态判定（2026-09-21 设计 §2）。
 *
 * 只看 GGUF 元数据，不看文件名——实测证明文件名不可信：`Native-MTP-Preserved`
 * 名字带 MTP 却是主模型，`Qwen3.8-27B-UD-Q4_K_XL` 名字不带却内嵌了 MTP 头。
 *
 * 判据是**张量数**而不是 block_count：sidecar 的 block_count 与主模型一样是 65、
 * general.name 都同叫 Qwen3.8-27B，只有 18 个张量暴露了它装不下 65 层。
 */
export type MtpKind = "none" | "embedded" | "sidecar";

/** 张量数 / 层数低于此值即判为挂件——「连一层的张量量都不够」。
 *  实测两端相差两个数量级（sidecar 0.28，主模型 13～18），阈值取中间极宽松 */
const SIDECAR_RATIO = 2;

/** blockCount 不可用时的退路：任何完整模型的张量都远超此数 */
const SIDECAR_ABSOLUTE = 50;

type MtpFields = Pick<GgufMeta, "tensorCount" | "nextnPredictLayers" | "blockCount">;

export function resolveMtpKind(meta: MtpFields): MtpKind {
  const nextn = meta.nextnPredictLayers;
  if (nextn === null || nextn === 0) return "none";

  const tensors = meta.tensorCount;
  // 张量数缺失（旧缓存行或解析截断）时无从分辨挂件，保守判 embedded：
  // 有 nextn 就让用户能开开关，配错了由 llama.cpp 的加载期报错兜底，
  // 比直接禁掉一个其实能用的模型强
  if (tensors === null) return "embedded";

  const blocks = meta.blockCount;
  if (blocks === null || blocks <= 0) {
    return tensors < SIDECAR_ABSOLUTE ? "sidecar" : "embedded";
  }
  return tensors / blocks < SIDECAR_RATIO ? "sidecar" : "embedded";
}
