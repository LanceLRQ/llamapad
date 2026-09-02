import { isSelectable, type RepoRow, type RepoRowState } from "./repo-files-view";

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

/**
 * 从档案详情页的 rows（父组件 mergeRepoRows/localOnlyRows 的产出）里挑出
 * README「模型权重」卡要展示的条目：只列 kind === "model" 的档，mmproj 是
 * 配套投影文件，不是可选的量化档。
 *
 * 不再在这里做数量截断——一行能放下几个是渲染宽度的函数，只有组件量过
 * DOM 才知道，交给 repo-weights-card.tsx 用 lib/fit-row.ts 按实测宽度决定
 * （任务 3 由「固定 6 个」改成「按宽度自适应」）。
 *
 * index 必须保留原数组下标——rows 经 filter 会打乱下标，而父组件的
 * `selected: Set<number>` 存的正是 rows 的原始下标，用过滤后的新下标去选
 * 会选中别的档。
 */
export function repoWeightItems(rows: readonly RepoRow[]): { items: RepoWeightItem[]; total: number } {
  const items: RepoWeightItem[] = [];
  rows.forEach((row, index) => {
    if (row.kind !== "model") return;
    items.push({
      index,
      quant: row.quant,
      totalSize: row.totalSize,
      state: row.state,
      selectable: isSelectable(row),
    });
  });

  return { items, total: items.length };
}
