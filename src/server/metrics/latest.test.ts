import { describe, expect, it } from "vitest";
import { METRIC_IDS } from "./ids";
import type { GpuDevice } from "./nvidiaSmi";
import {
  CONTAINER_STAT_METRICS,
  GPU_STAT_METRICS,
  HOST_STAT_METRICS,
  overlayLatestSamples,
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

  it("host 组恰含 hostStats 七指标", () => {
    expect([...HOST_STAT_METRICS]).toEqual([
      METRIC_IDS.hostCpuPercent,
      METRIC_IDS.hostMemUsedBytes,
      METRIC_IDS.hostMemPercent,
      METRIC_IDS.hostLoad1,
      METRIC_IDS.hostDiskFreeBytes,
      METRIC_IDS.hostNetRxBytesPerSec,
      METRIC_IDS.hostNetTxBytesPerSec,
    ]);
  });

  // 新增 host/stats 路由后由两组扩为三组（container/gpu/host 分别对应各自的
  // stats 路由）；不相交 + 并集为 METRIC_IDS 全集的不变式随之改为三组版本
  it("三组不相交且并集为 METRIC_IDS 全集", () => {
    const all = new Set([...CONTAINER_STAT_METRICS, ...GPU_STAT_METRICS, ...HOST_STAT_METRICS]);
    expect(all.size).toBe(
      CONTAINER_STAT_METRICS.length + GPU_STAT_METRICS.length + HOST_STAT_METRICS.length,
    );
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

describe("overlayLatestSamples（秒级指标采集 代号 B：ring 与秒级快照按 ts 取新者）", () => {
  it("fast 更新 → 覆盖 ring 的值", () => {
    const ring = { [METRIC_IDS.containerCpuPercent]: { value: 10, ts: 1_000 } };
    const fast = { [METRIC_IDS.containerCpuPercent]: { value: 20, ts: 2_000 } };
    expect(overlayLatestSamples(ring, fast, [METRIC_IDS.containerCpuPercent])).toEqual({
      [METRIC_IDS.containerCpuPercent]: { value: 20, ts: 2_000 },
    });
  });

  it("fast 更旧（ts 更小）→ 保留 ring 的值，不倒退", () => {
    const ring = { [METRIC_IDS.containerCpuPercent]: { value: 10, ts: 5_000 } };
    const fast = { [METRIC_IDS.containerCpuPercent]: { value: 999, ts: 1_000 } };
    expect(overlayLatestSamples(ring, fast, [METRIC_IDS.containerCpuPercent])).toEqual({
      [METRIC_IDS.containerCpuPercent]: { value: 10, ts: 5_000 },
    });
  });

  it("同 ts → 采用 fast（>= 判定，秒级快照的 ts 与 ring 末点撞车时以 fast 为准）", () => {
    const ring = { [METRIC_IDS.containerCpuPercent]: { value: 10, ts: 5_000 } };
    const fast = { [METRIC_IDS.containerCpuPercent]: { value: 11, ts: 5_000 } };
    expect(overlayLatestSamples(ring, fast, [METRIC_IDS.containerCpuPercent])).toEqual({
      [METRIC_IDS.containerCpuPercent]: { value: 11, ts: 5_000 },
    });
  });

  it("ring 无此指标、fast 有 → 直接采用 fast", () => {
    const fast = { [METRIC_IDS.containerMemBytes]: { value: 123, ts: 1_000 } };
    expect(overlayLatestSamples({}, fast, [METRIC_IDS.containerMemBytes])).toEqual({
      [METRIC_IDS.containerMemBytes]: { value: 123, ts: 1_000 },
    });
  });

  it("ring 有、fast 无此指标 → 保留 ring", () => {
    const ring = { [METRIC_IDS.containerMemBytes]: { value: 123, ts: 1_000 } };
    expect(overlayLatestSamples(ring, {}, [METRIC_IDS.containerMemBytes])).toEqual(ring);
  });

  it("两者都无 → 不出键", () => {
    expect(overlayLatestSamples({}, {}, [METRIC_IDS.containerMemBytes])).toEqual({});
  });

  it("只覆盖 ids 列出的指标：fast 混入的其他指标不会被带出去（container/gpu 路由互不串味）", () => {
    const ring = { [METRIC_IDS.containerCpuPercent]: { value: 10, ts: 1_000 } };
    const fast = {
      [METRIC_IDS.containerCpuPercent]: { value: 20, ts: 2_000 },
      [METRIC_IDS.gpuUtilPercent]: { value: 50, ts: 2_000 }, // 混入的 GPU 指标
    };
    const merged = overlayLatestSamples(ring, fast, [METRIC_IDS.containerCpuPercent]);
    expect(merged).toEqual({ [METRIC_IDS.containerCpuPercent]: { value: 20, ts: 2_000 } });
    expect(merged[METRIC_IDS.gpuUtilPercent]).toBeUndefined();
  });

  it("不改动入参（ring/fast 均不被写入）", () => {
    const ring = { [METRIC_IDS.containerCpuPercent]: { value: 10, ts: 1_000 } };
    const fast = { [METRIC_IDS.containerCpuPercent]: { value: 20, ts: 2_000 } };
    const ringSnapshot = JSON.parse(JSON.stringify(ring));
    const fastSnapshot = JSON.parse(JSON.stringify(fast));
    overlayLatestSamples(ring, fast, [METRIC_IDS.containerCpuPercent]);
    expect(ring).toEqual(ringSnapshot);
    expect(fast).toEqual(fastSnapshot);
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
