/**
 * 一行里能完整放下几个项（README 权重行用）：不做部分显示，放不下的项整个
 * 不展示——半个 chip 比不显示更难看。累加宽度，从第二个起先加一次 gap 再加
 * 宽度，累计值一旦超过可用宽度就停，此前累计放下的个数就是结果。
 *
 * 纯函数：调用方负责量好每个项的实测宽度（含内边距/边框），以及扣掉行尾
 * 常驻按钮及其 gap 之后的可用宽度，本函数只管这行算术。
 *
 * @param widths 每个项的实测宽度（px，按渲染顺序）
 * @param gap 相邻项之间的间距（px）
 * @param available 可用宽度（px，调用方要先扣掉行尾常驻按钮及其 gap）
 * @returns 能完整放下的项数；一个都放不下时返回 0
 */
export function fitCount(widths: readonly number[], gap: number, available: number): number {
  let used = 0;
  let count = 0;
  for (const width of widths) {
    const next = used + (count > 0 ? gap : 0) + width;
    if (next > available) break;
    used = next;
    count += 1;
  }
  return count;
}
