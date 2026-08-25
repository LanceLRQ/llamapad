import { describe, expect, it } from "vitest";

import { estimateEtaSeconds, formatEta } from "./eta";

describe("eta（UX P0 Task 10）", () => {
  it("estimateEtaSeconds：剩余/速度；无速度或已完成为 null", () => {
    expect(estimateEtaSeconds(100, 10)).toBe(10);
    expect(estimateEtaSeconds(0, 10)).toBeNull();
    expect(estimateEtaSeconds(100, 0)).toBeNull();
    expect(estimateEtaSeconds(-5, 10)).toBeNull();
  });

  it("formatEta：紧凑分档 59s / 12m 30s / 1h 05m / 3h", () => {
    expect(formatEta(59)).toBe("59s");
    expect(formatEta(60)).toBe("1m");
    expect(formatEta(750)).toBe("12m 30s");
    expect(formatEta(3900)).toBe("1h 05m");
    expect(formatEta(10800)).toBe("3h");
    // 边界：<1s 至少显示 1s（下载收尾时不显示 0s）
    expect(formatEta(0)).toBe("1s");
    expect(formatEta(0.4)).toBe("1s");
  });
});
