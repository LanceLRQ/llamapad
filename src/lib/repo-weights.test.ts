import { describe, expect, it } from "vitest";

import type { RepoRow, RepoRowState } from "./repo-files-view";
import { repoWeightItems, WEIGHTS_PREVIEW_LIMIT } from "./repo-weights";

/** 造一个最小合法 RepoRow，按需覆盖——默认给一个可选中下载的 Q4 model 行，
 *  多数用例只关心 kind/state/quant 三个字段 */
function row(over: Partial<RepoRow> = {}): RepoRow {
  return {
    quant: "Q4_K_M",
    kind: "model",
    files: ["model-q4_k_m.gguf"],
    totalSize: 4 * 1024 ** 3,
    state: "absent",
    progress: null,
    haveShards: 0,
    totalShards: 1,
    strayRel: null,
    models: [],
    localRels: [],
    taskStatus: null,
    ...over,
  };
}

describe("repoWeightItems", () => {
  it("排除 mmproj 行", () => {
    const rows = [row({ kind: "mmproj", quant: null }), row()];
    const result = repoWeightItems(rows);
    expect(result.items.every((item) => item.quant !== null || rows[item.index]?.kind === "model")).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it("index 是原数组下标，不是过滤后重新编号的下标", () => {
    const mmproj = row({ kind: "mmproj", quant: "mmproj-f16" });
    const q4 = row({ quant: "Q4_K_M" });
    const q8 = row({ quant: "Q8_0" });
    const rows = [mmproj, q4, q8];

    const result = repoWeightItems(rows);

    // q4 在原数组里是下标 1，过滤 mmproj 之后如果重新从 0 编号会得到 0——
    // 那会让父组件在 rows[index] 取到错误的档（这里会取到 mmproj 本身）
    expect(result.items.find((item) => item.quant === "Q4_K_M")?.index).toBe(1);
    expect(result.items.find((item) => item.quant === "Q8_0")?.index).toBe(2);
  });

  it("超过上限时只返回前 limit 个，hiddenCount 为剩余数，total 为 model 档总数", () => {
    const rows = Array.from({ length: 9 }, (_, i) => row({ quant: `Q${i}` }));
    const result = repoWeightItems(rows);
    expect(result.items).toHaveLength(WEIGHTS_PREVIEW_LIMIT);
    expect(result.items.map((item) => item.quant)).toEqual(["Q0", "Q1", "Q2", "Q3", "Q4", "Q5"]);
    expect(result.hiddenCount).toBe(3);
    expect(result.total).toBe(9);
  });

  it("不足上限时 hiddenCount 为 0", () => {
    const rows = Array.from({ length: 3 }, (_, i) => row({ quant: `Q${i}` }));
    const result = repoWeightItems(rows);
    expect(result.items).toHaveLength(3);
    expect(result.hiddenCount).toBe(0);
    expect(result.total).toBe(3);
  });

  it("空数组：items 空、total 0、hiddenCount 0", () => {
    const result = repoWeightItems([]);
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.hiddenCount).toBe(0);
  });

  it.each<[RepoRowState, boolean]>([
    ["absent", true],
    ["partial", true],
    ["present", false],
    ["downloading", false],
    ["stray", false],
  ])("selectable：state=%s 时为 %s", (state, expected) => {
    const result = repoWeightItems([row({ state })]);
    expect(result.items[0]?.selectable).toBe(expected);
  });

  it("limit 参数可覆盖默认值", () => {
    const rows = Array.from({ length: 5 }, (_, i) => row({ quant: `Q${i}` }));
    const result = repoWeightItems(rows, 2);
    expect(result.items).toHaveLength(2);
    expect(result.hiddenCount).toBe(3);
    expect(result.total).toBe(5);
  });
});
