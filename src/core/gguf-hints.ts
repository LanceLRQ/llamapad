/**
 * GGUF 元数据 → 参数越界提示纯函数（UX P1 U16 后半）
 *
 * 只覆盖 gpu_layers 与 ctx_size 两个「填错了会直接影响可用性」的参数：
 * gpu_layers 超过模型总层数、ctx_size 超过模型训练时的原生上下文窗口。
 * 二者都只是「警告」而非硬限制——llama.cpp 允许超配（前者按全卸载处理，
 * 后者会外推或直接报错，取决于版本与模型），面板不代用户做决定，只提醒。
 */

/** paramHints 所需的元数据字段，与 GgufMeta 结构兼容（core 层不反向依赖 server 的缓存类型） */
export interface GgufMetaLike {
  blockCount: number | null;
  contextLength: number | null;
}

export interface ParamHint {
  field: "gpu_layers" | "ctx_size";
  level: "warn";
  code: "gpuLayersExceed" | "ctxExceed";
  values: { actual: number; max: number };
}

/** 999 是项目内「全卸载」惯例值（见 param-presets.ts），不是真实层数诉求，豁免告警 */
const FULL_OFFLOAD = 999;

export function paramHints(
  meta: GgufMetaLike,
  params: { gpu_layers: number; ctx_size: number },
): ParamHint[] {
  const hints: ParamHint[] = [];

  if (meta.blockCount !== null && params.gpu_layers !== FULL_OFFLOAD && params.gpu_layers > meta.blockCount) {
    hints.push({
      field: "gpu_layers",
      level: "warn",
      code: "gpuLayersExceed",
      values: { actual: params.gpu_layers, max: meta.blockCount },
    });
  }

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
