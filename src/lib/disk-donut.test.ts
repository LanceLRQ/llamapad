import { describe, expect, it } from "vitest";

import { computeDiskDonut } from "./disk-donut";

describe("computeDiskDonut（磁盘剩余卡环形图的已用/剩余分段 + 使用率）", () => {
  it("正常场景：已用 = 总量 - 剩余，使用率四舍五入", () => {
    expect(computeDiskDonut(250, 1000)).toEqual({ usedBytes: 750, freeBytes: 250, percentUsed: 75 });
  });

  it("贴合卡头示例数值（441.2 / 1328 GiB 量级）：使用率取整", () => {
    const free = 441.2 * 1024 ** 3;
    const total = 1328 * 1024 ** 3;
    const result = computeDiskDonut(free, total);
    expect(result?.percentUsed).toBe(67); // (1328-441.2)/1328*100 ≈ 66.79 → 67
    expect(result?.freeBytes).toBe(free);
    expect(result?.usedBytes).toBeCloseTo(total - free);
  });

  it("total 缺失（未采到 hostDiskTotalBytes）时返回 null：组件按 null 不渲染环形图", () => {
    expect(computeDiskDonut(250, null)).toBeNull();
  });

  it("total 非正数（脏数据）时返回 null", () => {
    expect(computeDiskDonut(250, 0)).toBeNull();
    expect(computeDiskDonut(250, -100)).toBeNull();
  });

  it("剩余空间为 0（磁盘写满）是合法状态：已用 = 总量，使用率 100", () => {
    expect(computeDiskDonut(0, 1000)).toEqual({ usedBytes: 1000, freeBytes: 0, percentUsed: 100 });
  });

  it("脏数据 free > total 时已用夹到 0，不展示负数扇区", () => {
    expect(computeDiskDonut(1200, 1000)).toEqual({ usedBytes: 0, freeBytes: 1200, percentUsed: 0 });
  });
});
