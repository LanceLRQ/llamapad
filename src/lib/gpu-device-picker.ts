/**
 * GPU 挑卡卡片（components/models/gpu-device-picker.tsx）背后的纯判定
 *（GPU 挑卡卡片化批次）。三件事都是"渲染前先算清楚"，vitest 是
 * environment: node，组件本身测不了，全部落在这里配单测：
 *
 * - 显存条宽度：memTotalMib 为 0（探测到卡但显存读数尚未就绪）时不能产出
 *   NaN/Infinity，条会直接把布局撑坏
 * - 配置里有、机器上没有的卡：device= 手填了但设备列表探测不到的编号，
 *   不能被 GUI 静默吞掉（否则用户会以为面板把他的配置改没了）
 * - tensor_split 比例回显：把比例数组和可见卡号数组按位置配对，用户才知道
 *   自己写的 "3,1" 里 3 分给了哪张卡
 */

/** 显存占用率（供占用条宽度百分比）：total<=0 或算出 NaN/Infinity 一律 0，不臆测 */
export function gpuMemoryPercent(usedMib: number, totalMib: number): number {
  if (!(totalMib > 0)) return 0;
  const percent = (usedMib / totalMib) * 100;
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, percent));
}

/**
 * 已勾选但机器上不存在的卡号（差集，升序去重）。
 *
 * `selected` 通常来自 `parseSelectedDevices`（已升序去重），但这里不假定
 * 调用方遵守这一点，自己兜底去重排序——避免"谁负责去重"变成两边都不做。
 */
export function missingSelectedDevices(
  selected: readonly number[],
  availableIndexes: readonly number[],
): number[] {
  const available = new Set(availableIndexes);
  const missing = new Set(selected.filter((index) => !available.has(index)));
  return [...missing].sort((a, b) => a - b);
}

/** 比例↔卡号的一项配对结果 */
export interface TensorSplitPair {
  index: number;
  ratio: number;
}

/**
 * `tensor_split` 比例数组 → 与可见卡号数组按位置配对（llama.cpp 的
 * tensor_split 是位置参数：第 n 项对应容器内第 n 张卡，而容器内顺序就是
 * `visibleIndexes` 的数组顺序，见 lib/gpu-visibility.ts 头注释）。
 *
 * 项数不一致（或两边都是空数组，无卡可配）时返回 null——调用方据此不渲染
 * 这一行。越界/错配已经由 splitHints 的 tensorSplitCountMismatch 另行
 * 提示，这里不重复报同一件事。
 */
export function pairTensorSplitWithDevices(
  ratios: readonly number[],
  visibleIndexes: readonly number[],
): TensorSplitPair[] | null {
  if (ratios.length === 0 || ratios.length !== visibleIndexes.length) return null;
  return visibleIndexes.map((index, i) => ({ index, ratio: ratios[i]! }));
}
