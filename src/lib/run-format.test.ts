import { describe, expect, it } from "vitest";

import { formatDuration, formatPeakNetMib } from "./run-format";

describe("formatDuration（U17 运行历史时长紧凑格式）", () => {
  it("起止同一毫秒 → 0s", () => {
    expect(formatDuration(1_000, 1_000)).toBe("0s");
  });

  it("不足一分钟 → 秒级", () => {
    expect(formatDuration(0, 28_000)).toBe("28s");
  });

  it("整分钟边界（60s）→ 1m", () => {
    expect(formatDuration(0, 60_000)).toBe("1m");
  });

  it("59 分钟边界（3599s）→ 59m", () => {
    expect(formatDuration(0, 3_599_000)).toBe("59m");
  });

  it("整小时边界（3600s）→ 1h0m（分钟数为 0 仍显示 0m）", () => {
    expect(formatDuration(0, 3_600_000)).toBe("1h0m");
  });

  it("典型值（8040s）→ 2h14m", () => {
    expect(formatDuration(0, 8_040_000)).toBe("2h14m");
  });

  it("endedAt 早于 startedAt（时钟回拨）→ 不产生负数", () => {
    expect(formatDuration(10_000, 1_000)).toBe("0s");
  });
});

describe("formatPeakNetMib（U17 峰值显存净增量口径）", () => {
  it("peak 为 null → null", () => {
    expect(formatPeakNetMib(null, 1024)).toBeNull();
  });

  it("baseline 为 null → null", () => {
    expect(formatPeakNetMib(22528, null)).toBeNull();
  });

  it("两者都为 null → null", () => {
    expect(formatPeakNetMib(null, null)).toBeNull();
  });

  it("正常换算：peak 22528 / baseline 1024 → 21.0 GiB", () => {
    expect(formatPeakNetMib(22528, 1024)).toBe("21.0 GiB");
  });

  it("净增量恰为 0 → 0.0 GiB（合法的零，非「算不出」）", () => {
    expect(formatPeakNetMib(1024, 1024)).toBe("0.0 GiB");
  });

  it("净增量为负 → null（不同来源采样抖动导致的不可靠数据，不 clamp 到 0）", () => {
    expect(formatPeakNetMib(1024, 1536)).toBeNull();
  });
});
