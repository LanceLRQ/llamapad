/**
 * llama.cpp 启动日志加载进度解析（UX P0 Task 8 / U2）：把容器日志行流
 * 归约为"阶段 + 0–100 单调百分比"，供启动进度浮层渲染进度条。
 *
 * best-effort 契约：识别不了的行为"无进展"（保持上一状态），进度条只是
 * 照亮过程的辅助——浮层恒显最近日志尾行兜底，解析失败不误导用户。
 * 格式依据 llama.cpp server 当前输出（随版本漂移的风险见 07 计划风险簿①）：
 *
 *   llama_model_loader: loaded meta data ...            → 元数据阶段
 *   llama_model_loader: loading model part 1/2          → 张量阶段（按分片粗分）
 *   .................... done                            → 分片内点阵细推进
 *   load_tensors: offloaded 33/33 layers to GPU          → 张量后段
 *   listen: listening on 0.0.0.0:8080                    → 就绪
 *   main: server is ready to handle requests             → 就绪
 *
 * 权重：元数据 0–8%，张量分片 8–90%（片间均分、片内点阵细推），后段 92%，就绪 100。
 */

export type LoadStage = "loading" | "ready";

export interface LoadProgress {
  stage: LoadStage;
  /** 0–100，单调不减 */
  percent: number;
}

export const INITIAL_LOAD_PROGRESS: LoadProgress = { stage: "loading", percent: 0 };

/** 点阵行：一段连续句点（可选尾随 done），llama.cpp 分片内加载进度 */
const DOTS_LINE = /^(\.+)(?:\s*done)?$/i;

/** 元数据行（loader kv/type 明细或 meta data 汇总） */
const METADATA_LINE = /llama_model_loader:.*(\bkv\b|\btype\b|loaded meta data)/i;

/** 分片切换：loading model part i/n */
const PART_LINE = /loading model part (\d+)\/(\d+)/i;

/** 张量后段（加载完成、上下文构建、开始 listen） */
const LATE_LINE = /load_tensors|llama_new_context|listening on|server is ready/i;

/** 每片预设点阵格数（llama.cpp 每片约 50–60 点，取中值换算细粒度增量） */
const DOTS_PER_PART = 50;

/** 张量阶段总跨度（8%–90%） */
const TENSOR_SPAN = 82;
const TENSOR_BASE = 8;
const LATE_PERCENT = 92;

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** 用下一行日志推进进度（无进展时返回原引用，便于引用相等性短路渲染） */
export function advanceLoadProgress(prev: LoadProgress, line: string): LoadProgress {
  if (prev.stage === "ready") return prev;

  const part = PART_LINE.exec(line);
  if (part !== null) {
    const index = Number(part[1]);
    const total = Math.max(1, Number(part[2]));
    const percent = TENSOR_BASE + (TENSOR_SPAN * (index - 1)) / total;
    return percent > prev.percent
      ? { stage: "loading", percent: clampPercent(percent) }
      : prev;
  }

  const dots = DOTS_LINE.exec(line.trim());
  if (dots !== null && dots[1]!.length > 0) {
    // 片内点阵：按格数推进，封顶在"下一分片起点 / 后段起点"
    const cap = clampPercent(TENSOR_BASE + TENSOR_SPAN);
    const next = Math.min(prev.percent + (dots[1]!.length / DOTS_PER_PART) * 8, cap);
    return next > prev.percent ? { stage: "loading", percent: clampPercent(next) } : prev;
  }

  if (LATE_LINE.test(line)) {
    // listen/ready 行是终态；load_tensors/context 是后段里程碑
    if (/listening on|server is ready/i.test(line)) {
      return { stage: "ready", percent: 100 };
    }
    return prev.percent < LATE_PERCENT ? { stage: "loading", percent: LATE_PERCENT } : prev;
  }

  if (METADATA_LINE.test(line)) {
    return prev.percent < TENSOR_BASE ? { stage: "loading", percent: TENSOR_BASE } : prev;
  }

  return prev;
}
