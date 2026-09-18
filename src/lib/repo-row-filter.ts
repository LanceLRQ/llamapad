import { buildGroupingRows, repoRowCategory, type RepoRow } from "./repo-files-view";

/**
 * 具体量化标签归成的「档位」——档案详情页的档位筛选按位宽而非完整标签分组，
 * `IQ4_XS` 与 `Q4_K_M` 都归入 `Q4`：IQ 系列是同位宽的另一套量化算法，用户
 * 按位宽找档，不关心算法细节。未识别（`null`）与非 Qx 标签（`F16`/`BF16`/…）
 * 原样大写返回。
 */
export function quantTier(quant: string | null): string | null {
  if (quant === null) return null;
  const match = /^I?Q(\d+)/i.exec(quant);
  if (match !== null) return `Q${match[1]}`;
  return quant.toUpperCase();
}

/** `Q<n>` 档按 n 升序排在前，其余档位（F16/BF16/…）按字典序排在后面。 */
function compareTiers(a: string, b: string): number {
  const qa = /^Q(\d+)$/.exec(a);
  const qb = /^Q(\d+)$/.exec(b);
  if (qa !== null && qb !== null) return Number(qa[1]) - Number(qb[1]);
  if (qa !== null) return -1;
  if (qb !== null) return 1;
  return a.localeCompare(b);
}

/**
 * 收集可筛选的档位选项。辅助行（mmproj / MTP 草案权重，`repoRowCategory`
 * 判定为 `"auxiliary"`）不产生选项——它们本就不受档位筛选约束，出现在选项
 * 列表里只会误导用户以为点了会影响它们。`quantTier` 为 `null`（未识别）的
 * 行同样不产生选项。
 *
 * 与 `visibleRepoRowIndices` 同一条约束：类别判定要看得到目录名（MTP 草案
 * 权重可能只体现在目录名 `MTP/` 上，`RepoRow.files` 本身在 `mergeRepoRows`
 * 里已按 basename 收窄、不带目录），所以必须先用 `buildGroupingRows` 回填
 * 完整路径再判类别——否则会漏判目录里的 MTP 权重，多给出一个点了也没用的
 * 档位按钮，与本函数自己「辅助行不产生选项」的承诺相矛盾。
 */
export function collectQuantTiers(
  rows: readonly RepoRow[],
  remoteGroups: readonly { files: readonly { path: string }[] }[] | null | undefined,
): string[] {
  const groupingRows = buildGroupingRows(rows, remoteGroups);
  const tiers = new Set<string>();
  // buildGroupingRows 只替换 files（回填目录），quant 字段与原始行一致，
  // 直接用回填后的行即可，不必再回查 rows[index]（与 visibleRepoRowIndices 同一写法）
  for (const row of groupingRows) {
    if (repoRowCategory(row) === "auxiliary") continue;
    const tier = quantTier(row.quant);
    if (tier !== null) tiers.add(tier);
  }
  return [...tiers].sort(compareTiers);
}

export interface VisibleRepoRowIndicesInput {
  rows: readonly RepoRow[];
  remoteGroups: readonly { files: readonly { path: string }[] }[] | null | undefined;
  query: string;
  tiers: readonly string[];
}

/**
 * 档案详情页权重列表的前端筛选结果：返回通过筛选的行原始下标集合，下标口径
 * 与入参 `rows` 一致（页面所有渲染/选中都靠下标回查 `rows[index]`）。
 *
 * 类别判定（辅助行豁免档位筛选）要看得到目录名——MTP 草案权重可能只体现在
 * 目录名 `MTP/` 上，`RepoRow.files` 本身不带目录（`mergeRepoRows` 里按
 * basename 收窄），必须用 `buildGroupingRows` 回填后的行判类别，否则会漏判
 * 目录里的 MTP 权重。搜索用的完整路径同理来自回填后的行。
 */
export function visibleRepoRowIndices(input: VisibleRepoRowIndicesInput): Set<number> {
  const { rows, remoteGroups, query, tiers } = input;
  const trimmedQuery = query.trim().toLowerCase();
  const tierSet = new Set(tiers);
  const groupingRows = buildGroupingRows(rows, remoteGroups);

  const result = new Set<number>();
  groupingRows.forEach((row, index) => {
    if (trimmedQuery !== "" && !row.files.some((f) => f.toLowerCase().includes(trimmedQuery))) return;

    if (tierSet.size > 0 && repoRowCategory(row) !== "auxiliary") {
      // buildGroupingRows 只替换 files（回填目录），quant 字段与原始行一致，
      // 这里直接用回填后的行即可，不必再回查 rows[index]
      const tier = quantTier(row.quant);
      if (tier === null || !tierSet.has(tier)) return;
    }

    result.add(index);
  });
  return result;
}
