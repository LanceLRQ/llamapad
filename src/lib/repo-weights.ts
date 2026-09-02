import type { RepoRow, RepoRowState } from "./repo-files-view";

/** README 视图「模型权重」卡最多平铺展示的量化档数，超出的进「更多」——
 *  任务 2 决策，卡片要在一行内不换行放下，6 个是实测能放下的上限 */
export const WEIGHTS_PREVIEW_LIMIT = 6;

export interface RepoWeightItem {
  /** rows 数组里的原始下标——文件视图的 selected 用同一套索引，过滤 mmproj
   *  后如果重新编号会选中别的档，见本文件 repoWeightItems 的实现 */
  index: number;
  /** null = 量化未识别；不要在这里塞兜底中文，UI 负责翻译（同 RepoRow.quant 的约定） */
  quant: string | null;
  totalSize: number;
  state: RepoRowState;
  selectable: boolean;
}

/** 与 repo-detail-view.tsx 的 isSelectable 同一口径（state 为 absent/partial
 *  才可勾选下载）：那个函数没导出、不能直接 import，这里按同一条件重新实现一遍，
 *  改一处判定要记得同步改另一处 */
function isSelectable(state: RepoRowState): boolean {
  return state === "absent" || state === "partial";
}

/**
 * 从档案详情页的 rows（父组件 mergeRepoRows/localOnlyRows 的产出）里挑出
 * README「模型权重」卡要展示的条目：只列 kind === "model" 的档，mmproj 是
 * 配套投影文件，不是可选的量化档；最多取前 limit 个，其余数量报给
 * hiddenCount 供「更多」按钮标注。
 *
 * index 必须保留原数组下标——rows 经 filter 会打乱下标，而父组件的
 * `selected: Set<number>` 存的正是 rows 的原始下标，用过滤后的新下标去选
 * 会选中别的档。
 */
export function repoWeightItems(
  rows: readonly RepoRow[],
  limit: number = WEIGHTS_PREVIEW_LIMIT,
): { items: RepoWeightItem[]; hiddenCount: number; total: number } {
  const modelItems: RepoWeightItem[] = [];
  rows.forEach((row, index) => {
    if (row.kind !== "model") return;
    modelItems.push({
      index,
      quant: row.quant,
      totalSize: row.totalSize,
      state: row.state,
      selectable: isSelectable(row.state),
    });
  });

  return {
    items: modelItems.slice(0, limit),
    hiddenCount: Math.max(0, modelItems.length - limit),
    total: modelItems.length,
  };
}
