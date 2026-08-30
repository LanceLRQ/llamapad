import { describe, expect, it } from "vitest";
import { METRIC_IDS } from "./ids";
import {
  buildWindowPayload,
  parseRangeKey,
  planWindowQuery,
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
    const payload = buildWindowPayload("30m", 0, queried, "full");
    expect(payload.series[METRIC_IDS.containerCpuPercent]).toEqual(queried[METRIC_IDS.containerCpuPercent]);
    expect(payload.series[METRIC_IDS.gpuMemUsedMib]).toEqual(queried[METRIC_IDS.gpuMemUsedMib]);
  });

  it("未采集指标键存在但为空数组（前端按空数组判隐藏）", () => {
    const payload = buildWindowPayload("30m", 0, queried, "full");
    expect(payload.series[METRIC_IDS.gpuUtilPercent]).toEqual([]);
    expect(payload.series[METRIC_IDS.inferTokensPerSec]).toEqual([]);
  });

  it("series 键集恰为 METRIC_IDS 全集（形状稳定）", () => {
    const payload = buildWindowPayload("7d", 0, {}, "full");
    expect(Object.keys(payload.series).sort()).toEqual(Object.values(METRIC_IDS).sort());
  });

  it("range / from / resolution 透传", () => {
    const payload = buildWindowPayload("24h", 1_740_000_000_000, {}, "full");
    expect(payload).toMatchObject({ range: "24h", from: 1_740_000_000_000, resolution: "15m" });
  });

  it("mode 透传（full/delta 均如实反映在响应体上）", () => {
    expect(buildWindowPayload("30m", 0, {}, "full").mode).toBe("full");
    expect(buildWindowPayload("30m", 0, {}, "delta").mode).toBe("delta");
  });

  it("delta 模式下 series 仍是 METRIC_IDS 全集（空数组语义变了但键集不变）", () => {
    const payload = buildWindowPayload("30m", 0, queried, "delta");
    expect(Object.keys(payload.series).sort()).toEqual(Object.values(METRIC_IDS).sort());
  });
});

describe("planWindowQuery", () => {
  const from = 1_000_000;

  it.each([null, "", "abc", "NaN", "Infinity"])(
    "since 缺失/空串/非数字/非有限数（%j）→ full，忽略 since",
    (sinceRaw) => {
      expect(planWindowQuery("30m", sinceRaw, from)).toEqual({
        mode: "full",
        queryFrom: from,
        since: null,
      });
    },
  );

  it.each(["24h", "7d"] as const)(
    "%s 档即使带合法 since 也 → full（15min 桶迟到落盘会自愈改值，增量会把旧值钉死）",
    (range) => {
      expect(planWindowQuery(range, String(from + 1_000), from)).toEqual({
        mode: "full",
        queryFrom: from,
        since: null,
      });
    },
  );

  it("since < from（客户端数据已滑出窗口）→ full，整体替换", () => {
    expect(planWindowQuery("30m", String(from - 1), from)).toEqual({
      mode: "full",
      queryFrom: from,
      since: null,
    });
  });

  it.each(["30m", "2h"] as const)("%s 档带合法且 ≥ from 的 since → delta，queryFrom 即 since", (range) => {
    const since = from + 5_000;
    expect(planWindowQuery(range, String(since), from)).toEqual({
      mode: "delta",
      queryFrom: since,
      since,
    });
  });

  it("边界：since === from → delta（否决条件是严格小于）", () => {
    expect(planWindowQuery("30m", String(from), from)).toEqual({
      mode: "delta",
      queryFrom: from,
      since: from,
    });
  });
});
