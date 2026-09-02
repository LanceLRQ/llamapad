import { describe, expect, it } from "vitest";

import { BUILTIN_DEFAULT_CONFIG } from "@/core/config";
import { recommendDiff, selectedServer } from "./recommend-diff";

const effective = { ...BUILTIN_DEFAULT_CONFIG.server, temp: 0.8, ctx_size: 4096 };

describe("recommendDiff", () => {
  it("逐字段给出当前值与推荐值", () => {
    const rows = recommendDiff({ temp: 0.6, top_p: 0.95 }, effective);
    expect(rows).toEqual([
      { field: "temp", category: "sampling", current: 0.8, next: 0.6, changed: true, defaultChecked: true },
      {
        field: "top_p",
        category: "sampling",
        current: effective.top_p,
        next: 0.95,
        changed: effective.top_p !== 0.95,
        defaultChecked: true,
      },
    ]);
  });

  it("性能类默认不勾 —— 作者的显存不是用户的显存", () => {
    const [row] = recommendDiff({ ctx_size: 204800 }, effective);
    expect(row.category).toBe("perf");
    expect(row.defaultChecked).toBe(false);
  });

  it("与当前值相同的字段 changed=false，但仍然列出（让用户知道这项也被推荐过）", () => {
    const [row] = recommendDiff({ temp: 0.8 }, effective);
    expect(row.changed).toBe(false);
    expect(row.next).toBe(0.8);
  });

  it("字段顺序：采样类在前、性能类在后，同类按推荐里出现的顺序", () => {
    const rows = recommendDiff({ ctx_size: 8192, temp: 0.6, top_k: 20 }, effective);
    expect(rows.map((r) => r.field)).toEqual(["temp", "top_k", "ctx_size"]);
  });

  it("空推荐产出空数组", () => {
    expect(recommendDiff({}, effective)).toEqual([]);
  });
});

describe("selectedServer", () => {
  it("只把勾选的字段带出去", () => {
    const rows = recommendDiff({ temp: 0.6, ctx_size: 8192 }, effective);
    expect(selectedServer(rows, new Set(["temp"]))).toEqual({ temp: 0.6 });
  });

  it("一个都没勾选时产出空对象（调用方据此禁用「应用」按钮）", () => {
    const rows = recommendDiff({ temp: 0.6 }, effective);
    expect(selectedServer(rows, new Set())).toEqual({});
  });

  it("默认勾选集合 = 全部采样类", () => {
    const rows = recommendDiff({ temp: 0.6, ctx_size: 8192, top_p: 0.9 }, effective);
    const defaults = new Set(rows.filter((r) => r.defaultChecked).map((r) => r.field));
    expect(selectedServer(rows, defaults)).toEqual({ temp: 0.6, top_p: 0.9 });
  });
});
