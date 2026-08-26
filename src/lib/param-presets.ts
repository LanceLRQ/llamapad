/**
 * 参数快速预设（UX P1 U20 后半）：三档语义只覆盖性能区三键
 * （gpu_layers / cache_type_k / cache_type_v），ctx 与采样不动——预设解决的是
 * 「显存怎么分配」这一最高频决策，上下文长度留给用户按需调。
 *
 * 值域与表单字符串草稿一致：空串 = 清除覆盖（跟随默认）。
 * gpu_layers 用 999 表达「全卸载」（llama.cpp 对超过总层数的值按全卸载处理，
 * 比默认值 99 更直白）；cache_type_v 仅在 Flash Attention 开启时生效，预设
 * 仍随 K 一并写入，未开 FA 时自然被服务端忽略。
 */
export type ParamPresetId = "conservative" | "balanced" | "full";

/** 预设会触碰的草稿键（其余键一律不动） */
export type PresetDraftPatch = Partial<{ gpuLayers: string; cacheK: string; cacheV: string }>;

export const PARAM_PRESET_IDS: readonly ParamPresetId[] = ["conservative", "balanced", "full"];

/**
 * 保守：gpu_layers=0 纯 CPU 冒烟（下载完先验证文件能跑，再加层）；
 * 平衡：全卸载 + KV 量化 q8_0（几乎不掉速，显存省一截）；
 * 全卸载：全 GPU + KV 跟随默认（f16，最快最占显存）。
 */
export function presetDraftPatch(id: ParamPresetId): PresetDraftPatch {
  switch (id) {
    case "conservative":
      return { gpuLayers: "0", cacheK: "", cacheV: "" };
    case "balanced":
      return { gpuLayers: "999", cacheK: "q8_0", cacheV: "q8_0" };
    case "full":
      return { gpuLayers: "999", cacheK: "", cacheV: "" };
  }
}

/** 把预设补丁合入草稿（浅覆盖三键，返回新对象，不修改入参） */
export function applyPresetDraft<T extends PresetDraftPatch>(drafts: T, id: ParamPresetId): T {
  return { ...drafts, ...presetDraftPatch(id) };
}
