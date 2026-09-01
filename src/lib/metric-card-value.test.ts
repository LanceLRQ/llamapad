import { describe, expect, it } from "vitest";

import {
  cpuCoresSub,
  formatBytesPerSec,
  formatMib,
  formatPercent,
  formatTokensCompact,
  gpuMaxTempC,
  gpuMemMain,
  gpuMemPercentText,
  gpuTotalPowerW,
  percentText,
  toGib,
} from "./metric-card-value";

describe("formatPercent（百分比取整规则）", () => {
  it("小于 100 保留一位小数", () => {
    expect(formatPercent(12.34)).toEqual({ value: "12.3", unit: "%" });
  });

  it("大于等于 100 取整（多核 CPU 占用可超 100%）", () => {
    expect(formatPercent(1247.6)).toEqual({ value: "1248", unit: "%" });
    expect(formatPercent(100)).toEqual({ value: "100", unit: "%" });
  });
});

describe("percentText（副标行用的百分比纯文本）", () => {
  it("拼接 value 与 unit", () => {
    expect(percentText(63.5)).toBe("63.5%");
    expect(percentText(100)).toBe("100%");
  });
});

describe("toGib（MiB → GiB，固定一位小数）", () => {
  it("按 1024 换算并保留一位小数", () => {
    expect(toGib(1024)).toBe("1.0");
    expect(toGib(6234)).toBe("6.1");
  });
});

describe("formatMib（MiB 量级展示，<1GiB 用整数 MiB）", () => {
  it("小于 1024 MiB 显示整数 MiB", () => {
    expect(formatMib(512.4)).toEqual({ value: "512", unit: "MiB" });
  });

  it("大于等于 1024 MiB 换算为一位小数 GiB", () => {
    expect(formatMib(1536)).toEqual({ value: "1.5", unit: "GiB" });
  });
});

describe("formatTokensCompact（tokens 紧凑展示）", () => {
  it("小于 1000 显示整数", () => {
    expect(formatTokensCompact(842)).toEqual({ value: "842", unit: "tok" });
  });

  it("千级用 k 缩写，一位小数", () => {
    expect(formatTokensCompact(4_200)).toEqual({ value: "4.2k", unit: "tok" });
  });

  it("百万级用 M 缩写，一位小数", () => {
    expect(formatTokensCompact(2_500_000)).toEqual({ value: "2.5M", unit: "tok" });
  });
});

describe("formatBytesPerSec（字节/秒速率展示）", () => {
  it("小于等于 0 显示 0.0 KB/s（空闲不是未测到）", () => {
    expect(formatBytesPerSec(0)).toEqual({ value: "0.0", unit: "KB/s" });
    expect(formatBytesPerSec(-5)).toEqual({ value: "0.0", unit: "KB/s" });
  });

  it("正常速率复用 formatSize 换算量级并拼 /s", () => {
    expect(formatBytesPerSec(2 * 1024 * 1024)).toEqual({ value: "2.0", unit: "MB/s" });
  });
});

describe("cpuCoresSub（CPU 核数分母：核数 × 100 为满载值）", () => {
  it("16 核满载基准为 1600", () => {
    expect(cpuCoresSub(16)).toEqual({ count: 16, max: 1600 });
  });
});

describe("gpuMemMain（GPU 显存 used/total 大数字覆盖值）", () => {
  it("两个数字都按 GiB 对齐", () => {
    expect(gpuMemMain(6234, 24576)).toEqual({ value: "6.1 / 24.0", unit: "GiB" });
  });
});

describe("gpuMemPercentText（显存占用率文本）", () => {
  it("used/total 求百分比", () => {
    expect(gpuMemPercentText(6144, 24576)).toBe("25.0%");
  });
});

describe("gpuMaxTempC（GPU 温度取 max）", () => {
  it("多卡取最高温（最热的卡是瓶颈）", () => {
    expect(gpuMaxTempC([62, 71, 58])).toBe(71);
  });

  it("空数组返回 null（副标该段不拼）", () => {
    expect(gpuMaxTempC([])).toBeNull();
  });
});

describe("gpuTotalPowerW（GPU 功耗取 sum）", () => {
  it("多卡求和（供电视角）", () => {
    expect(gpuTotalPowerW([120, 135])).toBe(255);
  });

  it("空数组返回 null（副标该段不拼）", () => {
    expect(gpuTotalPowerW([])).toBeNull();
  });
});
