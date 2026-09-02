import { describe, expect, it } from "vitest";

import type { RepoRow, RepoRowState } from "./repo-files-view";
import { repoWeightItems } from "./repo-weights";

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

  it("不做数量截断：返回全部 model 档，total 与 items 长度一致", () => {
    const rows = Array.from({ length: 9 }, (_, i) => row({ quant: `Q${i}` }));
    const result = repoWeightItems(rows);
    expect(result.items).toHaveLength(9);
    expect(result.items.map((item) => item.quant)).toEqual([
      "Q0", "Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7", "Q8",
    ]);
    expect(result.total).toBe(9);
  });

  it("空数组：items 空、total 0", () => {
    const result = repoWeightItems([]);
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
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
});
