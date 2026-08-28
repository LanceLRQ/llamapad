/**
 * 量化标签纯逻辑（T3b，文件元信息 §3.5）：候选池 + 展示优先级 + 编辑态归一化。
 *
 * 候选池与 `core/files.ts` 的 QUANT_RE **来源独立**（决策见设计文档 §3.5）——
 * 后者是从文件名反推的模式，这里是给下拉框用的手工清单，源自 llama.cpp
 * `ggml_ftype` / `llama_model_quantize` 支持的量化类型名。新量化格式出现时
 * 两处各自跟进，不要试图合并成一份。
 */

/** 常见量化名候选池（llama.cpp 量化格式全大写命名），供下拉框展示 */
export const QUANT_CANDIDATES: readonly string[] = [
  // 旧式（数字后缀）
  "Q4_0",
  "Q4_1",
  "Q5_0",
  "Q5_1",
  "Q8_0",
  // K 量化
  "Q2_K",
  "Q3_K_S",
  "Q3_K_M",
  "Q3_K_L",
  "Q4_K_S",
  "Q4_K_M",
  "Q5_K_S",
  "Q5_K_M",
  "Q6_K",
  "Q8_K",
  // I 量化
  "IQ1_S",
  "IQ1_M",
  "IQ2_XXS",
  "IQ2_XS",
  "IQ2_S",
  "IQ2_M",
  "IQ3_XXS",
  "IQ3_XS",
  "IQ3_S",
  "IQ3_M",
  "IQ4_NL",
  "IQ4_XS",
  // 三值量化
  "TQ1_0",
  "TQ2_0",
  // 浮点
  "F16",
  "BF16",
  "F32",
];

export type QuantSource = "user" | "detected" | "none";

export interface QuantDisplay {
  /** 用于展示的值；source 为 "none" 时为 null */
  value: string | null;
  source: QuantSource;
}

/**
 * 展示优先级（设计 §3.5）：`quantLabel`（用户值）> `detectedQuant`（文件名推断）。
 * 空字符串视同未填。调用方据 source 决定是否加"推断"标注——**不要**把
 * source==="detected" 的 value 当成 quantLabel 预填进编辑框，那会让用户一保存
 * 就把推断值固化成手填值，是设计明确禁止的行为。
 */
export function resolveQuantDisplay(
  quantLabel: string | null,
  detectedQuant: string | null,
): QuantDisplay {
  if (quantLabel !== null && quantLabel.trim() !== "") {
    return { value: quantLabel, source: "user" };
  }
  if (detectedQuant !== null && detectedQuant.trim() !== "") {
    return { value: detectedQuant, source: "detected" };
  }
  return { value: null, source: "none" };
}

/** 编辑框提交前的归一化：去首尾空白，空串视为"显式清空"（PUT 语义里的 null） */
export function normalizeMetaField(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
