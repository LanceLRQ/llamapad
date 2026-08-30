import { describe, expect, it } from "vitest";
import { compareSampling, SAMPLING_ROWS } from "./props-drift";

const config = {
  temp: 0.8,
  top_k: 40,
  top_p: 0.95,
  min_p: 0.05,
  repeat_penalty: 1,
  presence_penalty: 0,
};

describe("compareSampling", () => {
  it("float32 回读抖动不算漂移（0.8 读回来是 0.800000011920929）", () => {
    const rows = compareSampling(config, { temperature: 0.800000011920929 });
    const temp = rows.find((r) => r.key === "temp")!;
    expect(temp.actual).toBe(0.800000011920929);
    expect(temp.drift).toBe(false);
  });

  it("真实差异算漂移", () => {
    const rows = compareSampling(config, { temperature: 0.6 });
    expect(rows.find((r) => r.key === "temp")!.drift).toBe(true);
  });

  it("props 缺该键时 actual 为 null 且不算漂移（无从判断，不误报）", () => {
    const rows = compareSampling(config, {});
    expect(rows.every((r) => r.actual === null && r.drift === false)).toBe(true);
  });

  it("整型参数精确比较", () => {
    const rows = compareSampling(config, { top_k: 40 });
    expect(rows.find((r) => r.key === "top_k")!.drift).toBe(false);
    const rows2 = compareSampling(config, { top_k: 41 });
    expect(rows2.find((r) => r.key === "top_k")!.drift).toBe(true);
  });

  it("props 里的非数值被当作缺失处理，不抛错", () => {
    const rows = compareSampling(config, { temperature: "0.8" as unknown as number });
    expect(rows.find((r) => r.key === "temp")!.actual).toBeNull();
  });

  it("行顺序固定，与 SAMPLING_ROWS 一致", () => {
    expect(compareSampling(config, {}).map((r) => r.key)).toEqual(
      SAMPLING_ROWS.map((r) => r.key),
    );
  });
});
