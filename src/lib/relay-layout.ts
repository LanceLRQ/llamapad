/**
 * API 中转页的布局判定（纯函数）。
 */

/**
 * 托管服务清单里哪些行默认展开参数区：只有 1 个时它展开；多个时只展开默认模型，
 * 没有默认（默认指向了外部上游）就全部收起，避免一屏长参数把后面的行挤出视口。
 */
export function initiallyExpanded(services: readonly { model: string; isDefault: boolean }[]): Set<string> {
  if (services.length === 1) return new Set([services[0].model]);
  return new Set(services.filter((s) => s.isDefault).map((s) => s.model));
}
