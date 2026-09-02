import type { ServerConfig } from "@/core/schemas";
import { presetServerToDraftPatch, type PresetDraftPatch } from "./preset-draft";

// 类型定义已搬到 preset-draft.ts（内置与用户预设共用），这里保留再导出，
// 免得下游 import 路径全跟着改
export type { PresetDraftPatch };

export type ParamPresetId = "conservative" | "balanced" | "full";

export const PARAM_PRESET_IDS: readonly ParamPresetId[] = ["conservative", "balanced", "full"];

/**
 * 内置三档的参数值。**留在代码里、不落 param_presets 表**：落库要处理
 * 「用户删了内置行怎么办」与「升级时补种」两个自找的问题，而内置项本来就该
 * 跟着代码版本走（迁移 v14 注释同此）。
 *
 * 保守：gpu_layers=0 纯 CPU 冒烟（下载完先验证文件能跑，再加层）；
 * 平衡：全卸载 + KV 量化 q8_0（几乎不掉速，显存省一截）；
 * 全卸载：全 GPU + KV 跟随默认（f16，最快最占显存）。
 * 999 是项目内「全卸载」惯例值（llama.cpp 对超过总层数的值按全卸载处理）。
 */
export function builtinPresetServer(id: ParamPresetId): Partial<ServerConfig> {
  switch (id) {
    case "conservative":
      return { gpu_layers: 0 };
    case "balanced":
      return { gpu_layers: 999, cache_type_k: "q8_0", cache_type_v: "q8_0" };
    case "full":
      return { gpu_layers: 999 };
  }
}

/** 预设会触碰的草稿键（其余键一律不动） */
export function presetDraftPatch(id: ParamPresetId): PresetDraftPatch {
  return presetServerToDraftPatch(builtinPresetServer(id));
}

/** 把预设补丁合入草稿（浅覆盖，返回新对象，不修改入参） */
export function applyPresetDraft<T extends PresetDraftPatch>(drafts: T, id: ParamPresetId): T {
  return { ...drafts, ...presetDraftPatch(id) };
}
