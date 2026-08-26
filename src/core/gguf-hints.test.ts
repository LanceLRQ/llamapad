import { describe, expect, it } from "vitest";
import { paramHints } from "./gguf-hints";

const meta = { architecture: "llama", blockCount: 32, contextLength: 8192, fileType: 15, version: 3, truncated: false };

describe("paramHints", () => {
  it("gpu_layers 超过层数 → warn", () => {
    expect(paramHints(meta, { gpu_layers: 40, ctx_size: 4096 })).toEqual([
      { field: "gpu_layers", level: "warn", code: "gpuLayersExceed", values: { actual: 40, max: 32 } },
    ]);
  });
  it("gpu_layers=999（全卸载惯例）不告警", () => {
    expect(paramHints(meta, { gpu_layers: 999, ctx_size: 4096 })).toEqual([]);
  });
  it("ctx_size 超原生窗口 → warn", () => {
    expect(paramHints(meta, { gpu_layers: 32, ctx_size: 16384 })).toEqual([
      { field: "ctx_size", level: "warn", code: "ctxExceed", values: { actual: 16384, max: 8192 } },
    ]);
  });
  it("ctx_size=0（跟随模型）不告警", () => {
    expect(paramHints(meta, { gpu_layers: 32, ctx_size: 0 })).toEqual([]);
  });
  it("元数据缺失时不产生任何提示", () => {
    expect(paramHints({ ...meta, blockCount: null, contextLength: null }, { gpu_layers: 99, ctx_size: 99999 })).toEqual([]);
  });
  it("两项同时越界返回两条", () => {
    expect(paramHints(meta, { gpu_layers: 40, ctx_size: 16384 })).toHaveLength(2);
  });
});
