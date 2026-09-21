/**
 * GGUF 元数据 → 参数越界提示纯函数（UX P1 U16 后半）
 *
 * 只覆盖 ctx_size 一个参数：ctx_size 超过模型训练时的原生上下文窗口是「填错了会
 * 直接影响可用性」的场景——llama.cpp 不 clamp，超配会外推或直接报错（取决于版本
 * 与模型），面板不代用户做决定，只提醒。
 *
 * gpu_layers 越界告警已删除（2026-09-21 真机缺陷 4）：原判据双重有误——
 * 1) 豁免值 999 对不上内置默认 `gpu_layers: 99`（core/config.ts），99 !== 999 且
 *    99 大于任何实测模型的 block_count，默认配置下每个模型的编辑页都常驻一条误报；
 * 2) 就算改对豁免值，判据本身也 off-by-one：可卸载总层数是 block_count + 1（多一个
 *    输出层）。真机实测 Qwen3.5-4B：`n_layer = 32`、`offloading output layer to GPU`、
 *    `offloaded 33/33 layers to GPU`——填 33（恰好全卸载）反而会被判定超出上限 32。
 * llama.cpp 对超过总层数的 gpu_layers 一律按全卸载处理（99 与 999 行为完全相同），
 * 「超出」根本不是错误状态，这条告警的存在本身就是错的，不是调参能修好的，故整条删除。
 * 真实可卸载层数改在 UI 层（model-params-form.tsx 的 gpu_layers 输入框）以 placeholder
 * 形式展示 block_count + 1，不产生告警也不写入值。
 */

/** paramHints 所需的元数据字段，与 GgufMeta 结构兼容（core 层不反向依赖 server 的缓存类型） */
export interface GgufMetaLike {
  contextLength: number | null;
}

export interface ParamHint {
  field: "ctx_size";
  level: "warn";
  code: "ctxExceed";
  values: { actual: number; max: number };
}

export function paramHints(meta: GgufMetaLike, params: { ctx_size: number }): ParamHint[] {
  const hints: ParamHint[] = [];

  // ctx_size=0 是「跟随模型自身默认」的惯用值，不是真实请求 0 长度上下文
  if (meta.contextLength !== null && params.ctx_size > 0 && params.ctx_size > meta.contextLength) {
    hints.push({
      field: "ctx_size",
      level: "warn",
      code: "ctxExceed",
      values: { actual: params.ctx_size, max: meta.contextLength },
    });
  }

  return hints;
}
