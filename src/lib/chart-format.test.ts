import { describe, expect, it } from "vitest";

import {
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
});
