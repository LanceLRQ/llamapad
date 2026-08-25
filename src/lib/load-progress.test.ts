import { describe, expect, it } from "vitest";

import { INITIAL_LOAD_PROGRESS, advanceLoadProgress } from "./load-progress";

/** 便捷：从初始状态按序喂入行 */
function through(lines: string[]) {
  return lines.reduce(advanceLoadProgress, INITIAL_LOAD_PROGRESS);
}

describe("load-progress（UX P0 Task 8）", () => {
  it("真实序列：元数据 → 分片 → 点阵 → 就绪，百分比单调爬升至 100", () => {
    const p1 = through(["llama_model_loader: loaded meta data (f16)"]);
    expect(p1.percent).toBe(8);

    const p2 = advanceLoadProgress(p1, "llama_model_loader: loading model part 1/2");
    expect(p2.percent).toBe(8);

    const p3 = advanceLoadProgress(p2, ".......................................... done");
    expect(p3.percent).toBeGreaterThan(p2.percent);
    expect(p3.percent).toBeLessThan(50);

    const p4 = advanceLoadProgress(p3, "llama_model_loader: loading model part 2/2");
    expect(p4.percent).toBe(49); // 8 + 82 * 1/2

    const late = advanceLoadProgress(p4, "load_tensors: offloaded 33/33 layers to GPU");
    expect(late.percent).toBe(92);

    const ready = advanceLoadProgress(late, "main: server is ready to handle requests");
    expect(ready).toEqual({ stage: "ready", percent: 100 });
  });

  it("就绪判据覆盖 listen 行；ready 后不再变化", () => {
    const ready = advanceLoadProgress(INITIAL_LOAD_PROGRESS, "listen: listening on 0.0.0.0:18080");
    expect(ready).toEqual({ stage: "ready", percent: 100 });
    expect(advanceLoadProgress(ready, "llama_model_loader: loading model part 1/2")).toBe(ready);
  });

  it("单调不减：乱序/重复行不回退进度", () => {
    let p = through([
      "llama_model_loader: loading model part 3/3", // 8 + 82*2/3 ≈ 63
      "llama_model_loader: loading model part 1/3", // 回到片 1（低于当前）→ 不回退
    ]);
    expect(p.percent).toBe(63);
    p = advanceLoadProgress(p, "llama_model_loader: - kv   0 : general.architecture str");
    expect(p.percent).toBe(63); // 元数据权重低于当前 → 不变
  });

  it("无关行不产生进展（引用相等短路）", () => {
    const prev = through(["llama_model_loader: loaded meta data"]);
    expect(advanceLoadProgress(prev, "2026-08-25 12:00:00 some random line")).toBe(prev);
    expect(advanceLoadProgress(prev, "")).toBe(prev);
  });

  it("点阵行封顶在张量阶段上界，不越权进入后段/就绪", () => {
    let p = INITIAL_LOAD_PROGRESS;
    for (let i = 0; i < 20; i += 1) {
      p = advanceLoadProgress(p, ".".repeat(60));
    }
    expect(p.percent).toBeLessThanOrEqual(90);
    expect(p.stage).toBe("loading");
  });

  it("无点阵的最小序列：meta → part 1/1 → ready", () => {
    const p = through([
      "llama_model_loader: loaded meta data",
      "llama_model_loader: loading model part 1/1",
      "main: server is ready to roll",
    ]);
    expect(p).toEqual({ stage: "ready", percent: 100 });
  });
});
