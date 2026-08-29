/**
 * Toolbar 筛选 chip 计数纯逻辑层（M16 T3）：把"计数不参与自身筛选"这条规则
 * 从组件里搬出来单独测试（对齐 lib/status-bar.ts、lib/page-header.ts 的既有
 * 做法——vitest 是 environment: "node"，组件渲染测试跑不动）。
 *
 * 核心规则：每个 chip 的计数只由「全量 items（经 searchMatch 收窄后）+ 它自己
 * 的 match」决定，绝不掺入其它 chip 的 match，函数签名里也刻意不收
 * "当前选中哪个 chip"——因为一旦让某个 chip 的选中状态参与计数计算，最常见的
 * 错误用法就是调用方把"当前已按选中 chip 过滤好的可见列表"传进来算计数，
 * 这会让其余 chip 的计数在其筛选口径下大多归零（比如选中"运行中"后拿可见
 * 列表算，"已停止"永远数出 0）——等于把用户点回其它筛选的出口焊死了。
 * 本函数要求调用方永远传全量 items，chip 是否处于选中态只是 UI 高亮，
 * 不该改变计数的输入。
 *
 * 搜索词则相反：它是全局收窄条件，所有 chip（包括当前选中的）都要在搜索结果
 * 内重新计数，因为搜索本就是在收窄"能看到什么"，不是"筛掉哪个分类"。
 */

export function computeChipCounts<T>(
  items: T[],
  chips: { key: string; match: (item: T) => boolean }[],
  searchMatch?: (item: T) => boolean,
): Record<string, number> {
  const searched = searchMatch ? items.filter(searchMatch) : items;

  const counts: Record<string, number> = {};
  for (const chip of chips) {
    counts[chip.key] = searched.filter(chip.match).length;
  }
  return counts;
}
