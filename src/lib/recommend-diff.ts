import type { ServerConfig } from "@/core/schemas";
import { PERF_FIELDS, SAMPLING_FIELDS, type ExtractableField } from "./readme-params";

/**
 * 推荐值 vs 当前生效值的逐字段 diff（README 推荐参数抽取 / 参数预设子系统共用）
 *
 * **性能类默认不勾**是这里唯一一处「面板替用户做判断」，理由值得写下来：
 * HauhauCS 的 README 给的是 `--ctx-size 204800`，它同一篇里写明了那是在
 * RTX PRO 6000 96GB 上测的；本机单卡 3090 24GB 照搬必然起不来。而采样参数
 * （temp/top_p/…）与硬件无关，是模型作者真正懂的东西，默认勾上。
 */

export interface DiffRow {
  field: ExtractableField;
  category: "sampling" | "perf";
  /** 当前生效值（default ⊕ overrides 之后的） */
  current: unknown;
  next: unknown;
  changed: boolean;
  defaultChecked: boolean;
}

export function recommendDiff(
  recommended: Partial<ServerConfig>,
  effective: ServerConfig,
): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const [rawField, next] of Object.entries(recommended)) {
    const field = rawField as ExtractableField;
    const sampling = SAMPLING_FIELDS.has(field);
    if (!sampling && !PERF_FIELDS.has(field)) continue; // 不认识的字段不展示
    const current = (effective as Record<string, unknown>)[field];
    rows.push({
      field,
      category: sampling ? "sampling" : "perf",
      current,
      next,
      changed: current !== next,
      defaultChecked: sampling,
    });
  }
  // 采样类排前面：它们是用户真正要看的，性能类是需要额外判断的附加项
  return rows.sort((a, b) => (a.category === b.category ? 0 : a.category === "sampling" ? -1 : 1));
}

/** 勾选的行 → 可写进 overrides.server 的对象 */
export function selectedServer(
  rows: readonly DiffRow[],
  selected: ReadonlySet<string>,
): Partial<ServerConfig> {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    if (selected.has(row.field)) out[row.field] = row.next;
  }
  return out as Partial<ServerConfig>;
}
