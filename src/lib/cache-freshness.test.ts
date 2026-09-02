import { describe, expect, it } from "vitest";

import { DEFAULT_CACHE_TTL_HOURS, isStale, resolveTtlMs } from "./cache-freshness";

const HOUR_MS = 3_600_000;

describe("resolveTtlMs", () => {
  it("未设置时回落默认 24 小时", () => {
    expect(resolveTtlMs(undefined)).toBe(DEFAULT_CACHE_TTL_HOURS * HOUR_MS);
  });

  it("合法正数按小时换算成毫秒", () => {
    expect(resolveTtlMs("6")).toBe(6 * HOUR_MS);
  });

  it("合法小数同样按小时换算", () => {
    expect(resolveTtlMs("0.5")).toBe(0.5 * HOUR_MS);
  });

  it('"0" 表示永不自动过期', () => {
    expect(resolveTtlMs("0")).toBe(Number.POSITIVE_INFINITY);
  });

  it("负数回落默认值，不抛异常", () => {
    expect(resolveTtlMs("-1")).toBe(DEFAULT_CACHE_TTL_HOURS * HOUR_MS);
  });

  it("非数字字符串回落默认值，不抛异常", () => {
    expect(resolveTtlMs("abc")).toBe(DEFAULT_CACHE_TTL_HOURS * HOUR_MS);
  });

  it("空串回落默认值，不抛异常", () => {
    expect(resolveTtlMs("")).toBe(DEFAULT_CACHE_TTL_HOURS * HOUR_MS);
  });
});

describe("isStale", () => {
  const now = 10_000_000;

  it("刚取的不过期", () => {
    expect(isStale(now, now, HOUR_MS)).toBe(false);
  });

  it("age 恰好等于 ttl 的边界算不过期", () => {
    expect(isStale(now - HOUR_MS, now, HOUR_MS)).toBe(false);
  });

  it("超过一点点算过期", () => {
    expect(isStale(now - HOUR_MS - 1, now, HOUR_MS)).toBe(true);
  });

  it("fetchedAt 为 0 算过期", () => {
    expect(isStale(0, 1_000_000, HOUR_MS)).toBe(true);
  });

  it("fetchedAt 为负数也算过期", () => {
    expect(isStale(-1, 1_000_000, HOUR_MS)).toBe(true);
  });

  it("ttlMs 为 Infinity 时永远不过期", () => {
    expect(isStale(1, 1_000_000_000, Number.POSITIVE_INFINITY)).toBe(false);
  });
});
