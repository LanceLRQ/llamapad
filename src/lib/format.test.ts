import { describe, expect, it } from "vitest";

import { formatCount, toGigabytes } from "./format";

describe("toGigabytes", () => {
  it("小于 100 GB 时保留 1 位小数", () => {
    expect(toGigabytes(2.1 * 1024 ** 3)).toBe(2.1);
  });

  it("大于等于 100 GB 时取整", () => {
    expect(toGigabytes(215.7 * 1024 ** 3)).toBe(216);
  });

  it("0 字节返回 0", () => {
    expect(toGigabytes(0)).toBe(0);
  });
});

describe("formatCount", () => {
  it("千位以下原样", () => {
    expect(formatCount(886)).toBe("886");
    expect(formatCount(0)).toBe("0");
  });

  it("千位用 k，百万位用 M", () => {
    expect(formatCount(4440)).toBe("4.4k");
    expect(formatCount(1908396)).toBe("1.9M");
  });

  it("整数结果省掉 .0", () => {
    expect(formatCount(1000)).toBe("1k");
    expect(formatCount(1000000)).toBe("1M");
  });

  it("负数与非有限值落 0", () => {
    expect(formatCount(-1)).toBe("0");
    expect(formatCount(Number.NaN)).toBe("0");
  });
});
