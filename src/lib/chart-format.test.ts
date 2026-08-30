import { describe, expect, it } from "vitest";

import type { WindowPayload } from "@/server/metrics/window";
import {
  buildChartRows,
  downsample,
  formatBytesAxis,
  formatMibAxis,
  formatPercent,
  latestValue,
  mergeSeries,
  toleranceFor,
} from "./chart-format";

describe("toleranceFor（分辨率 → 归并容差）", () => {
  it("5s 分辨率 → 2500ms", () => {
    expect(toleranceFor("5s")).toBe(2_500);
  });

  it("15m 分辨率 → 450000ms", () => {
    expect(toleranceFor("15m")).toBe(450_000);
  });
});

describe("mergeSeries（宿主机网络收发卡：rx/tx 按 ts 就近归并）", () => {
  it("两列长度、ts 完全对齐 → 逐点配对", () => {
    const rx = [{ ts: 0, value: 10 }, { ts: 1000, value: 20 }];
    const tx = [{ ts: 0, value: 1 }, { ts: 1000, value: 2 }];
    expect(mergeSeries(rx, tx, 100)).toEqual([
      { ts: 0, a: 10, b: 1 },
      { ts: 1000, a: 20, b: 2 },
    ]);
  });

  it("ts 漂移在容差内 → 仍视为同一时刻合并", () => {
    const rx = [{ ts: 1000, value: 10 }];
    const tx = [{ ts: 1200, value: 1 }];
    expect(mergeSeries(rx, tx, 2_500)).toEqual([{ ts: 1000, a: 10, b: 1 }]);
  });

  it("一列缺失该时刻的点 → 该字段 undefined，不假造 0", () => {
    const rx = [{ ts: 0, value: 10 }, { ts: 10_000, value: 30 }];
    const tx = [{ ts: 0, value: 1 }];
    expect(mergeSeries(rx, tx, 100)).toEqual([
      { ts: 0, a: 10, b: 1 },
      { ts: 10_000, a: 30 },
    ]);
  });

  it("两列皆空 → 空数组（卡片据此判空态）", () => {
    expect(mergeSeries([], [], 100)).toEqual([]);
  });
});

describe("downsample（步进抽稀，防 recharts 卡顿）", () => {
  it("点数不超过上限 → 原样返回", () => {
    const rows = Array.from({ length: 500 }, (_, i) => i);
    expect(downsample(rows)).toEqual(rows);
  });

  it("超过上限 → 步进采样且强制保留末点", () => {
    const rows = Array.from({ length: 1001 }, (_, i) => i);
    const out = downsample(rows);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out[out.length - 1]).toBe(1000);
  });
});

describe("latestValue（图例当前值，空序列 null）", () => {
  it("undefined → null", () => {
    expect(latestValue(undefined)).toBeNull();
  });

  it("空数组 → null", () => {
    expect(latestValue([])).toBeNull();
  });

  it("非空 → 末点的值", () => {
    expect(latestValue([{ ts: 0, value: 1 }, { ts: 1, value: 2 }])).toBe(2);
  });
});

describe("formatPercent（百分比展示）", () => {
  it("小于 100 → 一位小数", () => {
    expect(formatPercent(12.345)).toBe("12.3%");
  });

  it("大于等于 100（多核 CPU 可超）→ 取整", () => {
    expect(formatPercent(342.7)).toBe("343%");
  });
});

describe("formatMibAxis / formatBytesAxis（轴刻度量级不能错位）", () => {
  it("formatMibAxis：小于 1024 MiB → M", () => {
    expect(formatMibAxis(512)).toBe("512M");
  });

  it("formatMibAxis：大于等于 1024 MiB → G，一位小数", () => {
    expect(formatMibAxis(6246.4)).toBe("6.1G");
  });

  it("formatBytesAxis：原始字节先换算 MiB 再分档——276 MiB 而非 282624.0G", () => {
    const bytes = 276 * 1024 * 1024;
    expect(formatBytesAxis(bytes)).toBe("276M");
    // 回归用例：曾经误把字节序列直接喂给 formatMibAxis，量级错了约一千倍
    expect(formatMibAxis(bytes)).not.toBe(formatBytesAxis(bytes));
  });

  it("formatBytesAxis：跨 GiB 分档同样一位小数", () => {
    expect(formatBytesAxis(6.1 * 1024 ** 3)).toBe("6.1G");
  });

  // 真机观察：网络卡实际值在 3–19 KB/s，只有 M/G 两档时五个刻度全被压成
  // "1M/s" 与 "0M/s"，读不出任何差别。轴必须能下探到 K 与 B。
  it("formatBytesAxis：不足 1 MiB 降到 K 档", () => {
    expect(formatBytesAxis(3 * 1024)).toBe("3K");
    expect(formatBytesAxis(19 * 1024)).toBe("19K");
  });

  it("formatBytesAxis：不足 1 KiB 降到 B 档", () => {
    expect(formatBytesAxis(512)).toBe("512B");
  });

  it("formatBytesAxis：零不带单位（轴上 \"0B\" 比 \"0\" 更碍眼）", () => {
    expect(formatBytesAxis(0)).toBe("0");
  });

  it("formatMibAxis：不足 1 MiB 的 MiB 值同样降档（GPU 显存 0.25 MiB = 256K）", () => {
    expect(formatMibAxis(0.25)).toBe("256K");
    expect(formatMibAxis(0)).toBe("0");
  });

  it("整数值不留多余的 .0（轴刻度要短）", () => {
    expect(formatBytesAxis(3 * 1024)).toBe("3K");
    expect(formatMibAxis(1)).toBe("1M");
  });

  it("回归：量级相邻的真实网络刻度必须互不相同", () => {
    const ticks = [0, 5 * 1024, 10 * 1024, 15 * 1024, 20 * 1024].map(formatBytesAxis);
    expect(new Set(ticks).size).toBe(ticks.length);
    expect(ticks).toEqual(["0", "5K", "10K", "15K", "20K"]);
  });

  it("负值不产生 \"-0\" 之类的怪串（速率理论上不为负，防御性）", () => {
    expect(formatBytesAxis(-3 * 1024)).toBe("-3K");
  });
});

describe("buildChartRows（图卡取行：卡片与弹层共用同一条取行路径）", () => {
  function payloadOf(
    series: WindowPayload["series"],
    resolution: WindowPayload["resolution"] = "5s",
  ): WindowPayload {
    return { range: "30m", from: 0, resolution, series, mode: "full" };
  }

  it("single：取到对应 metric 的序列", () => {
    const points = [{ ts: 0, value: 1 }, { ts: 1000, value: 2 }];
    const payload = payloadOf({ "gpu.mem_used_mib": points });
    expect(buildChartRows(payload, { kind: "single", metric: "gpu.mem_used_mib" })).toEqual(points);
  });

  it("single：series 里没有该 metric 键 → 空数组（不是 undefined）", () => {
    const payload = payloadOf({});
    expect(buildChartRows(payload, { kind: "single", metric: "gpu.mem_used_mib" })).toEqual([]);
  });

  it("pair：按 ts 就近归并为 a/b 两条同轴线", () => {
    const rx = [{ ts: 0, value: 10 }];
    const tx = [{ ts: 0, value: 1 }];
    const payload = payloadOf({ rx, tx });
    expect(
      buildChartRows(payload, { kind: "pair", metricA: "rx", metricB: "tx" }),
    ).toEqual([{ ts: 0, a: 10, b: 1 }]);
  });

  it("pair：tolerance 随 resolution 走——5s 分辨率下 3000ms 漂移视为两个独立时刻", () => {
    const rx = [{ ts: 0, value: 10 }];
    const tx = [{ ts: 3000, value: 1 }];
    const payload = payloadOf({ rx, tx }, "5s");
    expect(
      buildChartRows(payload, { kind: "pair", metricA: "rx", metricB: "tx" }),
    ).toEqual([
      { ts: 0, a: 10 },
      { ts: 3000, b: 1 },
    ]);
  });

  it("pair：15m 分辨率下同样 3000ms 漂移仍视为同一时刻合并", () => {
    const rx = [{ ts: 0, value: 10 }];
    const tx = [{ ts: 3000, value: 1 }];
    const payload = payloadOf({ rx, tx }, "15m");
    expect(
      buildChartRows(payload, { kind: "pair", metricA: "rx", metricB: "tx" }),
    ).toEqual([{ ts: 0, a: 10, b: 1 }]);
  });

  it("超过 MAX_RENDER_POINTS 时抽稀生效，且强制保留末点", () => {
    const points = Array.from({ length: 501 }, (_, i) => ({ ts: i, value: i }));
    const payload = payloadOf({ m: points });
    const rows = buildChartRows(payload, { kind: "single", metric: "m" });
    expect(rows.length).toBeLessThanOrEqual(500);
    expect(rows[rows.length - 1]).toEqual(points[points.length - 1]);
  });
});
