/**
 * `PANEL_FAKE_GPUS`：dev-only 假多卡数据源的张数开关（见 server/metrics/fake-gpus.ts
 * 与 server/locators.ts 的接线）。这里只做字符串 → 合法张数的纯判定，不碰
 * NODE_ENV——是否放行"生产环境也认这个变量"由 locators.ts 的接线层决定，
 * 这个函数只负责"这串字符像不像一个合法张数"，两层关注点分开才好各自单测。
 *
 * 非正整数（空串 / "0" / 负数 / 小数 / 非数字）一律当作未设置 → null，
 * 不抛异常：一个写错的 env 变量不该让面板启动失败，只是假卡功能不生效。
 */
export function parseFakeGpuCount(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isInteger(value) && value > 0 ? value : null;
}
