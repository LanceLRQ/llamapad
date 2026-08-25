import { describe, expect, it } from "vitest";
import { METRIC_IDS } from "./ids";
import {
  buildWindowPayload,
  parseRangeKey,
  RANGE_DEFS,
  RANGE_KEYS,
  resolutionForRange,
} from "./window";

/**
 * 指标窗口查询纯函数测试（M3 Task 4，TDD）：
 * route 只做鉴权 + 组装（getDb/getMetricsStore 不可单测），
 * range 解析与响应整形的行为全部收敛在这里覆盖。
 */

describe("parseRangeKey", () => {
  it.each(RANGE_KEYS)("合法 range %s 解析通过", (key) => {
    expect(parseRangeKey(key)).toBe(key);
  });

  it("缺失（null）返回 null", () => {
    expect(parseRangeKey(null)).toBeNull();
  });

  it.each(["", "1h", "12h", "30M", "m30", "7d ", "foo"])("非法值 %j 返回 null", (raw) => {
    expect(parseRangeKey(raw)).toBeNull();
  });
});

describe("RANGE_DEFS 时长换算", () => {
  it("四档换算为毫秒", () => {
    expect(RANGE_DEFS["30m"]).toBe(30 * 60_000);
    expect(RANGE_DEFS["2h"]).toBe(2 * 3_600_000);
    expect(RANGE_DEFS["24h"]).toBe(24 * 3_600_000);
    expect(RANGE_DEFS["7d"]).toBe(7 * 24 * 3_600_000);
  });
});

describe("resolutionForRange", () => {
  it("短窗口（ring 覆盖）报 5s", () => {
    expect(resolutionForRange("30m")).toBe("5s");
    expect(resolutionForRange("2h")).toBe("5s");
  });

  it("长窗口（15min 桶降源）报 15m", () => {
    expect(resolutionForRange("24h")).toBe("15m");
    expect(resolutionForRange("7d")).toBe("15m");
  });
});

describe("buildWindowPayload", () => {
  const queried = {
    [METRIC_IDS.containerCpuPercent]: [
      { ts: 1_000, value: 12.5 },
      { ts: 6_000, value: 13 },
    ],
    [METRIC_IDS.gpuMemUsedMib]: [{ ts: 1_000, value: 4_096 }],
  };

  it("已采集指标按原样透传", () => {
    const payload = buildWindowPayload("30m", 0, queried);
    expect(payload.series[METRIC_IDS.containerCpuPercent]).toEqual(queried[METRIC_IDS.containerCpuPercent]);
    expect(payload.series[METRIC_IDS.gpuMemUsedMib]).toEqual(queried[METRIC_IDS.gpuMemUsedMib]);
  });

  it("未采集指标键存在但为空数组（前端按空数组判隐藏）", () => {
    const payload = buildWindowPayload("30m", 0, queried);
    expect(payload.series[METRIC_IDS.gpuUtilPercent]).toEqual([]);
    expect(payload.series[METRIC_IDS.inferTokensPerSec]).toEqual([]);
  });

  it("series 键集恰为 METRIC_IDS 全集（形状稳定）", () => {
    const payload = buildWindowPayload("7d", 0, {});
    expect(Object.keys(payload.series).sort()).toEqual(Object.values(METRIC_IDS).sort());
  });

  it("range / from / resolution 透传", () => {
    const payload = buildWindowPayload("24h", 1_740_000_000_000, {});
    expect(payload).toMatchObject({ range: "24h", from: 1_740_000_000_000, resolution: "15m" });
  });
});
