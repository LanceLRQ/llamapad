import { describe, expect, it } from "vitest";
import { diffDiskRate, isPhysicalDisk, parseDiskstats, type DiskCounterSnapshot } from "./hostDisk";

/**
 * 宿主机磁盘 IO 纯函数测试（任务 12：D2 决定磁盘剩余折线改磁盘 IO）。
 *
 * fixture 取自真机 `head /proc/diskstats` 实测行（见 hostDisk.ts 头注释的字段
 * 位置核对），字段顺序按内核文档 1-indexed：3=设备名、6=读扇区累计、
 * 10=写扇区累计——与网络指标 hostNet.ts 一样，先落纯函数单测，采集编排里
 * 只管调用不重复判定。
 */

describe("parseDiskstats：解析 /proc/diskstats", () => {
  it("解析真实格式多行（真机 head -5 /proc/diskstats 实测行）", () => {
    const text = [
      "   7       0 loop0 45 0 700 21 0 0 0 0 0 20 21 0 0 0 0 0 0",
      " 259       0 nvme0n1 49417 28691 3682338 21148 18578 56383 2371242 52512 0 13746 76550 0 0 0 0 2221 2889",
      " 259       1 nvme0n1p1 49106 26562 3657656 21035 18576 56383 2371240 52512 0 15044 73547 0 0 0 0 0 0",
    ].join("\n");

    expect(parseDiskstats(text)).toEqual([
      { device: "loop0", readSectors: 700, writeSectors: 0 },
      { device: "nvme0n1", readSectors: 3682338, writeSectors: 2371242 },
      { device: "nvme0n1p1", readSectors: 3657656, writeSectors: 2371240 },
    ]);
  });

  it("空行与字段不足的畸形行整行跳过", () => {
    const text = ["", "   7       0 loop0 45 0", " 259       0 nvme0n1 49417 28691 3682338 21148 18578 56383 2371242 52512 0 13746 76550"].join(
      "\n",
    );
    expect(parseDiskstats(text)).toEqual([{ device: "nvme0n1", readSectors: 3682338, writeSectors: 2371242 }]);
  });

  it("扇区字段非数值的行整行跳过", () => {
    const text = " 259       0 nvme0n1 49417 28691 abc 21148 18578 56383 2371242 52512 0 13746 76550";
    expect(parseDiskstats(text)).toEqual([]);
  });
});

describe("isPhysicalDisk：物理盘过滤（重复计数是本任务唯一的新判定）", () => {
  it("物理盘命中：sda / nvme0n1 / vda / hda", () => {
    expect(isPhysicalDisk("sda")).toBe(true);
    expect(isPhysicalDisk("nvme0n1")).toBe(true);
    expect(isPhysicalDisk("vda")).toBe(true);
    expect(isPhysicalDisk("hda")).toBe(true);
  });

  it("分区排除：父设备已含其统计，重复计入会翻倍", () => {
    expect(isPhysicalDisk("sda1")).toBe(false);
    expect(isPhysicalDisk("nvme0n1p1")).toBe(false);
  });

  it("虚拟/映射设备排除：loop* / ram* / sr* / dm-*（dm 与底层物理盘重复）", () => {
    expect(isPhysicalDisk("loop0")).toBe(false);
    expect(isPhysicalDisk("ram0")).toBe(false);
    expect(isPhysicalDisk("sr0")).toBe(false);
    expect(isPhysicalDisk("dm-0")).toBe(false);
  });
});

describe("diffDiskRate：累计扇区差分 × 512 字节/扇区", () => {
  it("按时间差换算字节/秒", () => {
    const prev: DiskCounterSnapshot = { readSectors: 1_000, writeSectors: 2_000, ts: 0 };
    const curr: DiskCounterSnapshot = { readSectors: 3_000, writeSectors: 2_500, ts: 2_000 }; // 2s
    // 读：(3000-1000)*512/2s = 512000；写：(2500-2000)*512/2s = 128000
    expect(diffDiskRate(prev, curr)).toEqual({ readBytesPerSec: 512_000, writeBytesPerSec: 128_000 });
  });

  it("计数器回绕/重置（curr < prev）→ null，不产负速率", () => {
    const prev: DiskCounterSnapshot = { readSectors: 5_000, writeSectors: 5_000, ts: 0 };
    const curr: DiskCounterSnapshot = { readSectors: 100, writeSectors: 5_100, ts: 1_000 };
    expect(diffDiskRate(prev, curr)).toBeNull();
  });

  it("dt<=0 → null", () => {
    const prev: DiskCounterSnapshot = { readSectors: 1_000, writeSectors: 1_000, ts: 1_000 };
    const curr: DiskCounterSnapshot = { readSectors: 2_000, writeSectors: 2_000, ts: 1_000 };
    expect(diffDiskRate(prev, curr)).toBeNull();
  });
});
