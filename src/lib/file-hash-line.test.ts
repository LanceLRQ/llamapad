import { describe, expect, it } from "vitest";

import { truncateHash } from "./file-hash-line";

describe("truncateHash", () => {
  it("入参为 null（未计算）时两个字段都返回 null", () => {
    expect(truncateHash(null)).toEqual({ short: null, full: null });
  });

  it("入参为空字符串时两个字段都返回 null", () => {
    expect(truncateHash("")).toEqual({ short: null, full: null });
  });

  it("短于 8 位时原样返回、不加省略号", () => {
    // 哈希理应是 64 位，短于 8 位是脏数据；截了反而看不出它不对劲
    expect(truncateHash("1234567")).toEqual({ short: "1234567", full: "1234567" });
  });

  it("恰好 8 位时原样返回、不加省略号", () => {
    expect(truncateHash("12345678")).toEqual({ short: "12345678", full: "12345678" });
  });

  it("真实 64 位 sha256 截断为前 8 位 + 省略号", () => {
    const value = "3fa91c7e9b2d5a01" + "0".repeat(48);
    expect(truncateHash(value)).toEqual({ short: "3fa91c7e…", full: value });
  });
});
