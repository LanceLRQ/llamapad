import { describe, expect, it } from "vitest";

import { toGigabytes } from "./format";

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
