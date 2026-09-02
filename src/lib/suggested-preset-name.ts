/**
 * 推荐参数卡「存为预设」的默认名称拼装（README 推荐参数抽取）
 *
 * 格式：`${仓库基名}-${label 或 "official"}` 转小写连字符。用户在保存弹层里仍可改，
 * 这里只给一个不用动脑子就能接受的默认值——不追求语义完美，只求合法且可辨认。
 */
export function suggestedPresetName(repoBaseName: string, label: string): string {
  const raw = `${repoBaseName}-${label.trim() === "" ? "official" : label}`;
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
