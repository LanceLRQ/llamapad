import type { ServerConfig } from "@/core/schemas";
import { toFloatOrNull, toIntOrNull, type DraftState } from "./model-form";

/**
 * 参数预设 ↔ 表单草稿互转（参数预设子系统）
 *
 * 表单草稿全是字符串（空串 = 未覆盖，见 lib/model-form.ts 的 DraftState），
 * 预设存的是类型化的 `Partial<ServerConfig>`。两边各有各的道理，转换收在这一处：
 * 内置三档与用户预设从此走同一条应用路径，不各写一份。
 *
 * **不写 ≠ 清空**：预设里没有的字段不进补丁，套用时那一项保持原样。想清掉某项
 * 覆盖是「把输入框清空」这个动作的语义，不该由套预设顺带做掉。
 */

/** 预设可含的 server 字段 ↔ 草稿键。一期只覆盖 server 段（设计 §12） */
const FIELD_TO_DRAFT = {
  gpu_layers: "gpuLayers",
  ctx_size: "ctxSize",
  cache_type_k: "cacheK",
  cache_type_v: "cacheV",
  flash_attention: "flashAttn",
  enable_thinking: "thinking",
  reasoning_effort: "effort",
  temp: "temp",
  top_p: "topP",
  top_k: "topK",
  min_p: "minP",
  repeat_penalty: "repeatPenalty",
  presence_penalty: "presencePenalty",
} as const satisfies Partial<Record<keyof ServerConfig, keyof DraftState>>;

type PresetField = keyof typeof FIELD_TO_DRAFT;

/** 整数字段：其余数值字段按浮点解析 */
const INT_FIELDS = new Set<PresetField>(["gpu_layers", "ctx_size", "top_k"]);
/** 浮点字段 */
const FLOAT_FIELDS = new Set<PresetField>(["temp", "top_p", "min_p", "repeat_penalty", "presence_penalty"]);

export type PresetDraftPatch = Partial<Pick<DraftState, (typeof FIELD_TO_DRAFT)[PresetField]>>;

/** 预设值 → 草稿补丁（只含预设里真的写了的键） */
export function presetServerToDraftPatch(server: Partial<ServerConfig>): PresetDraftPatch {
  const patch: Record<string, string> = {};
  for (const [field, draftKey] of Object.entries(FIELD_TO_DRAFT) as [PresetField, string][]) {
    const value = server[field];
    if (value === undefined) continue;
    patch[draftKey] = String(value);
  }
  return patch as PresetDraftPatch;
}

/** 草稿 → 预设值（空串与非法值一律丢弃；`0` 是有效值，不能当空处理） */
export function draftToPresetServer(drafts: DraftState): Partial<ServerConfig> {
  const server: Record<string, unknown> = {};
  for (const [field, draftKey] of Object.entries(FIELD_TO_DRAFT) as [PresetField, keyof DraftState][]) {
    const raw = String(drafts[draftKey] ?? "").trim();
    if (raw === "") continue;

    if (INT_FIELDS.has(field)) {
      const n = toIntOrNull(raw);
      if (n !== null) server[field] = n;
      continue;
    }
    if (FLOAT_FIELDS.has(field)) {
      const n = toFloatOrNull(raw);
      if (n !== null) server[field] = n;
      continue;
    }
    if (field === "enable_thinking") {
      if (raw === "true" || raw === "false") server[field] = raw === "true";
      continue;
    }
    server[field] = raw; // 枚举：cache_type_* / flash_attention / reasoning_effort
  }
  return server as Partial<ServerConfig>;
}
