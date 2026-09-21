import { describe, expect, it } from "vitest";
import { paramHints } from "./gguf-hints";

const meta = { contextLength: 8192 };

describe("paramHints", () => {
  it("ctx_size 超原生窗口 → warn", () => {
    expect(paramHints(meta, { ctx_size: 16384 })).toEqual([
      { field: "ctx_size", level: "warn", code: "ctxExceed", values: { actual: 16384, max: 8192 } },
    ]);
  });
  it("ctx_size=0（跟随模型）不告警", () => {
    expect(paramHints(meta, { ctx_size: 0 })).toEqual([]);
  });
  it("元数据缺失时不产生任何提示", () => {
    expect(paramHints({ contextLength: null }, { ctx_size: 99999 })).toEqual([]);
  });
});
