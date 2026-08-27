import { describe, expect, it } from "vitest";
import { METRIC_IDS } from "./ids";
import type { GpuDevice } from "./nvidiaSmi";
import {
  CONTAINER_STAT_METRICS,
  GPU_STAT_METRICS,
  pickLatestSamples,
  STATS_LOOKBACK_MS,
  sumGpuTotals,
} from "./latest";

/**
 * 当前值快照纯函数测试（M3 Task 5，TDD）：route 只做鉴权 + 组装
 * （getDb/getMetricsStore 不可单测），样本挑选行为全部收敛在这里覆盖。
 */

describe("STATS_LOOKBACK_MS", () => {
  it("回看窗口为 60s", () => {
    expect(STATS_LOOKBACK_MS).toBe(60_000);
  });
});

describe("指标键集", () => {
  it("container 组恰含 dockerStats + health 六指标", () => {
    expect([...CONTAINER_STAT_METRICS]).toEqual([
      METRIC_IDS.containerCpuPercent,
      METRIC_IDS.containerMemBytes,
      METRIC_IDS.containerMemPercent,
      METRIC_IDS.inferTokensPerSec,
      METRIC_IDS.inferKvCacheTokens,
      METRIC_IDS.inferSlotsRunning,
    ]);
  });

  it("gpu 组恰含 nvidiaSmi 两指标", () => {
    expect([...GPU_STAT_METRICS]).toEqual([
      METRIC_IDS.gpuMemUsedMib,
      METRIC_IDS.gpuUtilPercent,
    ]);
  });

  it("两组不相交且并集为 METRIC_IDS 全集", () => {
    const all = new Set([...CONTAINER_STAT_METRICS, ...GPU_STAT_METRICS]);
    expect(all.size).toBe(CONTAINER_STAT_METRICS.length + GPU_STAT_METRICS.length);
    expect([...all].sort()).toEqual(Object.values(METRIC_IDS).sort());
  });
});

describe("pickLatestSamples", () => {
  it("升序序列取末点为当前值", () => {
    const queried = {
      [METRIC_IDS.containerCpuPercent]: [
        { ts: 1_000, value: 10 },
        { ts: 6_000, value: 12.5 },
        { ts: 11_000, value: 11 },
      ],
    };
    expect(pickLatestSamples(queried, [METRIC_IDS.containerCpuPercent]).samples).toEqual({
      [METRIC_IDS.containerCpuPercent]: { value: 11, ts: 11_000 },
    });
  });

  it("窗口内无点的指标不出键（前端判 —）", () => {
    const result = pickLatestSamples(
      { [METRIC_IDS.containerCpuPercent]: [] },
      [METRIC_IDS.containerCpuPercent, METRIC_IDS.gpuMemUsedMib],
    );
    expect(result.samples).toEqual({});
  });

  it("queryRange 结果缺失的指标同样不出键", () => {
    expect(pickLatestSamples({}, [...GPU_STAT_METRICS]).samples).toEqual({});
  });

  it("乱序输入按 ts 取最大（防御，不依赖调用方有序）", () => {
    const queried = {
      [METRIC_IDS.gpuUtilPercent]: [
        { ts: 30_000, value: 61 },
        { ts: 5_000, value: 40 },
        { ts: 20_000, value: 55 },
      ],
    };
    expect(pickLatestSamples(queried, [METRIC_IDS.gpuUtilPercent]).samples).toEqual({
      [METRIC_IDS.gpuUtilPercent]: { value: 61, ts: 30_000 },
    });
  });

  it("同 ts 多点取遍历中最后一点（ring 优先语义由 queryRange 保证）", () => {
    const queried = {
      [METRIC_IDS.inferSlotsRunning]: [
        { ts: 10_000, value: 1 },
        { ts: 10_000, value: 2 },
      ],
    };
    expect(
      pickLatestSamples(queried, [METRIC_IDS.inferSlotsRunning]).samples[
        METRIC_IDS.inferSlotsRunning
      ],
    ).toEqual({ value: 2, ts: 10_000 });
  });
});

describe("sumGpuTotals", () => {
  /** 分卡明细构造：只有 memUsedMib/memTotalMib 参与求和，其余字段填占位值 */
  function device(memUsedMib: number, memTotalMib: number): GpuDevice {
    return { index: 0, memUsedMib, memTotalMib, utilPercent: 0, tempC: null, powerW: null };
  }

  it("空数组 → null（没有卡就没有分母）", () => {
    expect(sumGpuTotals([])).toBeNull();
  });

  it("单卡 → 该卡自身的 used/total", () => {
    expect(sumGpuTotals([device(8192, 24576)])).toEqual({
      memUsedMib: 8192,
      memTotalMib: 24576,
    });
  });

  it("双卡 → used 与 total 各自求和", () => {
    expect(sumGpuTotals([device(8192, 24576), device(6144, 24576)])).toEqual({
      memUsedMib: 14336,
      memTotalMib: 49152,
    });
  });

  it("不改动入参", () => {
    const devices = [device(8192, 24576), device(6144, 24576)];
    const snapshot = devices.map((d) => ({ ...d }));
    sumGpuTotals(devices);
    expect(devices).toEqual(snapshot);
  });
});
