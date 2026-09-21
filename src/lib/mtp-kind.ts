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

/** blockCount 不可用时的退路：任何完整模型的张量都远超此数。
 *  实测依据同 SIDECAR_RATIO——本轮四个真实权重的张量数是 sidecar 18、
 *  主模型 753 / 851 / 866，50 落在 18 与 753 之间且离两端都很远 */
const SIDECAR_ABSOLUTE = 50;

type MtpFields = Pick<
  GgufMeta,
  "tensorCount" | "splitTensorsTotal" | "nextnPredictLayers" | "blockCount"
>;

export function resolveMtpKind(meta: MtpFields): MtpKind {
  const nextn = meta.nextnPredictLayers;
  if (nextn === null || nextn === 0) return "none";

  // 分片模型的 tensor_count 是每片各算各的，必须用 split.tensors.count 的总数，
  // 否则分片越多比值越低、越容易被误判成挂件（实测 GLM-5.3 BF16 33 片：
  // 第一片 95 张量 / 79 层 = 1.20 会判成 sidecar，总数 1809 / 79 = 22.9 才对）
  const tensors = meta.splitTensorsTotal ?? meta.tensorCount;
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

/** 编辑页 MTP 节要显示的提示。开关一律可开，这里只决定提示内容与轻重
 *（见 resolveMtpNotice 头注的实测依据——原「none 时置灰」的设计假设已被推翻）。 */
export type MtpNotice =
  | { kind: "none" }
  /** 说明性：权重自带 MTP 层，留空加速权重即可 */
  | { kind: "info"; message: "embedded" }
  /** 警告但不拦截：开了 MTP、权重不含 MTP 层、又没关联加速权重 */
  | { kind: "warn"; message: "needsDraft" }
  /** 警告但不拦截：拿 MTP 挂件当主模型用了 */
  | { kind: "warn"; message: "isSidecar" }
  /** 警告但不拦截：选了加速权重却没开开关 */
  | { kind: "warn"; message: "draftWithoutSwitch" };

/**
 * MTP 开关不再按 mtpKind 置灰（2026-09-21 设计变更）：`none`（不含 MTP 层）时禁用开关的
 * 原假设已被真机实测推翻——`unsloth/Qwen3.8-27B-GGUF` 的 `Qwen3.8-27B-UD-IQ1_S.gguf`
 * （851 张量 / 64 层 / nextn=0，判定 none）配上 `mtp-Qwen3.8-27B-Q4_0.gguf` 这个 sidecar，
 * 在 `ghcr.io/ggml-org/llama.cpp:server-cuda13` 上实跑：基线 55.6/55.8 tok/s → 开 MTP 后
 * 68.8/70.2 tok/s，提速约 1.25 倍（draft_n=118→accepted=67，接受率约 58%）。sidecar 的
 * 正当用途正是给 none 权重补 MTP 头，原置灰逻辑把这唯一用途堵死了。故改为「检测 + 警告
 * 但不拦截」：开关永远可开，这里只挑提示内容。
 */
export function resolveMtpNotice(input: {
  mtpKind: MtpKind | null;
  /** 生效的 spec_type（合并后的值，不是草稿片段） */
  specType: "none" | "draft-mtp";
  hasDraftFile: boolean;
}): MtpNotice {
  const { mtpKind, specType, hasDraftFile } = input;

  // sidecar 优先级最高，不受开关/draft 状态影响：拿加速权重当主模型用本身就是
  // 配置错误，无论用户接下来怎么摆弄开关都成立
  if (mtpKind === "sidecar") return { kind: "warn", message: "isSidecar" };

  if (specType === "none") {
    // 关着开关时选了加速权重不会被下发，这条与 mtpKind 无关——mtpKind 为 null
    // （新建/克隆页尚未解析主权重）时也适用，是"除 draftWithoutSwitch 外不警告"的例外
    return hasDraftFile ? { kind: "warn", message: "draftWithoutSwitch" } : { kind: "none" };
  }

  // 以下 specType === "draft-mtp"
  if (mtpKind === "none") {
    // 有 draft 就是实测跑通的组合（见上方函数头注），没有才提醒去关联加速权重
    return hasDraftFile ? { kind: "none" } : { kind: "warn", message: "needsDraft" };
  }
  if (mtpKind === "embedded") {
    // 权重自带 MTP 层，留空是正常用法；顺手挂了 draft 也无害（llama.cpp 用外挂那份），
    // 不算错误，不警告
    return hasDraftFile ? { kind: "none" } : { kind: "info", message: "embedded" };
  }
  // mtpKind === null：新建/克隆页还没解析出主权重，未知就不拦、也不提示
  return { kind: "none" };
}
