import { describe, expect, it } from "vitest";
import type { WindowPayload } from "@/server/metrics/window";
import { mergeWindowPayload, nextSince, SAFETY_MS, windowUrl } from "./metrics-window-merge";

/**
 * 窗口增量合并纯函数测试（指标窗口增量协议，方案 A，TDD）：降源判定完全
 * 在服务端（window.ts 的 planWindowQuery），这里只测客户端的合并语义——
 * 客户端只认 mode 字段，不做任何自己的判断。
 */

function payload(overrides: Partial<WindowPayload> & Pick<WindowPayload, "mode">): WindowPayload {
  return {
    range: "30m",
    from: 0,
    resolution: "5s",
    series: {},
    ...overrides,
  };
}

describe("mergeWindowPayload", () => {
  it("full 直接替换（哪怕 held 有更多点）", () => {
    const held = payload({
      mode: "full",
      series: {
        m1: [
          { ts: 1, value: 1 },
          { ts: 2, value: 2 },
          { ts: 3, value: 3 },
        ],
      },
    });
    const incoming = payload({ mode: "full", series: { m1: [{ ts: 3, value: 3 }] } });

    expect(mergeWindowPayload(held, incoming)).toBe(incoming);
  });

  it("delta 追加新点到已有序列尾部", () => {
    const held = payload({ mode: "full", series: { m1: [{ ts: 10, value: 1 }] } });
    const incoming = payload({ mode: "delta", from: 0, series: { m1: [{ ts: 20, value: 2 }] } });

    const merged = mergeWindowPayload(held, incoming);

    expect(merged.series.m1).toEqual([
      { ts: 10, value: 1 },
      { ts: 20, value: 2 },
    ]);
  });

  it("delta 裁掉 ts < incoming.from 的旧点（滑出窗口）", () => {
    const held = payload({
      mode: "full",
      series: {
        m1: [
          { ts: 5, value: 1 },
          { ts: 15, value: 2 },
        ],
      },
    });
    const incoming = payload({ mode: "delta", from: 10, series: { m1: [{ ts: 20, value: 3 }] } });

    const merged = mergeWindowPayload(held, incoming);

    expect(merged.series.m1).toEqual([
      { ts: 15, value: 2 },
      { ts: 20, value: 3 },
    ]);
  });

  it("delta 里某 series 为空数组时，该 series 的历史不被清空", () => {
    const held = payload({ mode: "full", series: { m1: [{ ts: 10, value: 1 }] } });
    const incoming = payload({ mode: "delta", from: 0, series: { m1: [] } });

    const merged = mergeWindowPayload(held, incoming);

    expect(merged.series.m1).toEqual([{ ts: 10, value: 1 }]);
  });

  it("幂等：同一个 delta 连续应用两次，结果与应用一次相同", () => {
    const held = payload({ mode: "full", series: { m1: [{ ts: 10, value: 1 }] } });
    const incoming = payload({
      mode: "delta",
      from: 0,
      series: {
        m1: [
          { ts: 10, value: 1 },
          { ts: 20, value: 2 },
        ],
      },
    });

    const once = mergeWindowPayload(held, incoming);
    const twice = mergeWindowPayload(once, incoming);

    expect(twice).toEqual(once);
  });

  it("held === null → 返回 incoming", () => {
    const incoming = payload({ mode: "delta", series: { m1: [{ ts: 1, value: 1 }] } });
    expect(mergeWindowPayload(null, incoming)).toBe(incoming);
  });

  it("held.range !== incoming.range → 返回 incoming（防御性；正常流程切档不带 since）", () => {
    const held = payload({ mode: "full", range: "2h", series: {} });
    const incoming = payload({ mode: "delta", range: "30m", series: { m1: [{ ts: 1, value: 1 }] } });

    expect(mergeWindowPayload(held, incoming)).toBe(incoming);
  });
});

describe("nextSince", () => {
  it("取全部 series 里的全局最大 ts，减去安全边距 SAFETY_MS", () => {
    const p = payload({
      mode: "full",
      series: {
        m1: [{ ts: 10, value: 1 }],
        m2: [
          { ts: 30, value: 2 },
          { ts: 20, value: 3 },
        ],
      },
    });

    expect(nextSince(p)).toBe(30 - SAFETY_MS);
  });

  it("全部 series 都为空数组时返回 null（不是负数的“全局最大 ts”）", () => {
    const p = payload({ mode: "full", series: { m1: [], m2: [] } });
    expect(nextSince(p)).toBeNull();
  });

  it("null 入参返回 null", () => {
    expect(nextSince(null)).toBeNull();
  });

  it("回归：某序列滞后一整个心跳时，水位仍留出余量把它的下一个点追回来", () => {
    // a 是全局最大 ts 的来源（10000）；b 滞后正好一个心跳，停在 5000——
    // 若水位直接取全局最大 ts 不留边距，b 在 ts=10000 补上的那个点会被
    // 服务端 `ts > since` 挡在门外，且 since 已经推过去，永远追不回来。
    // 这条用例把 SAFETY_MS 改成 0 会失败：nextSince 会返回 10000，
    // 10000 <= 10000 - 1 不成立。
    const held = payload({
      mode: "full",
      series: {
        a: [{ ts: 10_000, value: 1 }],
        b: [{ ts: 5_000, value: 2 }],
      },
    });

    const since = nextSince(held);

    expect(since).toBeLessThanOrEqual(10_000 - 1);
  });
});

describe("windowUrl", () => {
  it("held 为 null 时不带 since 参数", () => {
    expect(windowUrl("30m", null)).toBe("/api/v1/metrics/window?range=30m");
  });

  it("全部 series 为空（nextSince 得 null）时同样不带 since 参数", () => {
    const held = payload({ mode: "full", series: { m1: [] } });
    expect(windowUrl("30m", held)).toBe("/api/v1/metrics/window?range=30m");
  });

  it("有数据时带上 since，取值等于 nextSince(held)", () => {
    const held = payload({ mode: "full", series: { m1: [{ ts: 20_000, value: 1 }] } });
    expect(windowUrl("2h", held)).toBe(`/api/v1/metrics/window?range=2h&since=${nextSince(held)}`);
  });

  it("URL 里绝不出现 since=null / since=NaN / since=undefined", () => {
    const cases = [null, payload({ mode: "full", series: {} }), payload({ mode: "full", series: { m1: [] } })];
    for (const held of cases) {
      const url = windowUrl("30m", held);
      expect(url).not.toMatch(/since=(null|NaN|undefined)/);
    }
  });
});
