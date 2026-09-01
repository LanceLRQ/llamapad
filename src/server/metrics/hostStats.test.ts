import type os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDb, runMigrations } from "../db";
import { saveHostNetIfacePreference } from "./hostNet";
import {
  createHostStatsCollector,
  diffCpuPercent,
  diffNetRate,
  summarizeCpuTimes,
  type CpuTimesSnapshot,
} from "./hostStats";
import { METRIC_IDS } from "./ids";

/**
 * 宿主机指标采集器测试（TDD）：本文件是 CPU times 差分、网络字节差分的单测
 * 落点，以及采集编排（1s 内部节拍、首轮基线、/proc 缺失降级、网络计数器
 * 重置/切卡）的集成验证。磁盘 IO 的差分/过滤纯函数单测在 hostDisk.test.ts，
 * 本文件只补编排层用例（任务 12：接入 1s 定时器、失败降级对齐网络口径）。
 */

// ---------- 纯函数：CPU times 差分 ----------

function cpuInfo(idleMs: number, busyMs: number): os.CpuInfo {
  return { model: "", speed: 0, times: { user: busyMs, nice: 0, sys: 0, idle: idleMs, irq: 0 } };
}

describe("summarizeCpuTimes：多核 times 求和", () => {
  it("两核累加 idle 与总量", () => {
    const cpus = [cpuInfo(200, 150), cpuInfo(300, 100)];
    expect(summarizeCpuTimes(cpus)).toEqual({ idleMs: 500, totalMs: 750 });
  });

  it("单核", () => {
    expect(summarizeCpuTimes([cpuInfo(100, 0)])).toEqual({ idleMs: 100, totalMs: 100 });
  });
});

describe("diffCpuPercent：idle 增量 / 总增量 = 空闲率，100 - 空闲率×100 = 利用率", () => {
  it("半忙半闲", () => {
    const prev: CpuTimesSnapshot = { idleMs: 100, totalMs: 1000 };
    const curr: CpuTimesSnapshot = { idleMs: 150, totalMs: 1100 }; // idleΔ50 / totalΔ100
    expect(diffCpuPercent(prev, curr)).toBeCloseTo(50, 6);
  });

  it("完全空闲（idleΔ==totalΔ）→ 0%", () => {
    expect(diffCpuPercent({ idleMs: 0, totalMs: 0 }, { idleMs: 100, totalMs: 100 })).toBeCloseTo(0, 6);
  });

  it("完全繁忙（idleΔ==0）→ 100%", () => {
    expect(diffCpuPercent({ idleMs: 100, totalMs: 1000 }, { idleMs: 100, totalMs: 1100 })).toBeCloseTo(100, 6);
  });

  it("总时间未增长（时钟未走/重复采样）→ null", () => {
    expect(diffCpuPercent({ idleMs: 100, totalMs: 1000 }, { idleMs: 100, totalMs: 1000 })).toBeNull();
    expect(diffCpuPercent({ idleMs: 100, totalMs: 1000 }, { idleMs: 100, totalMs: 900 })).toBeNull();
  });
});

// ---------- 纯函数：网络字节差分 ----------

describe("diffNetRate：计数器差分换算字节/秒", () => {
  it("按时间差换算", () => {
    const prev = { rxBytes: 1_000, txBytes: 2_000, ts: 0 };
    const curr = { rxBytes: 3_000, txBytes: 2_500, ts: 2_000 }; // 2s
    expect(diffNetRate(prev, curr)).toEqual({ rxBytesPerSec: 1_000, txBytesPerSec: 250 });
  });

  it("计数器重置（curr < prev，网卡重置/重建）→ null，不产负数速率", () => {
    const prev = { rxBytes: 5_000, txBytes: 5_000, ts: 0 };
    const curr = { rxBytes: 100, txBytes: 5_100, ts: 1_000 };
    expect(diffNetRate(prev, curr)).toBeNull();
  });

  it("dt<=0 → null", () => {
    const prev = { rxBytes: 1_000, txBytes: 1_000, ts: 1_000 };
    const curr = { rxBytes: 2_000, txBytes: 2_000, ts: 1_000 };
    expect(diffNetRate(prev, curr)).toBeNull();
  });
});

// ---------- 采集编排 ----------

/** /proc/net/dev 最简构造：两行占位表头（无冒号，天然被解析器跳过）+ 数据行 */
function netDevText(rows: Record<string, { rx: number; tx: number }>): string {
  const lines = ["H1", "H2"];
  for (const [iface, t] of Object.entries(rows)) {
    lines.push(`  ${iface}: ${t.rx} 0 0 0 0 0 0 0 ${t.tx} 0 0 0 0 0 0 0`);
  }
  return lines.join("\n");
}

/** /proc/net/route 最简构造：单行占位表头 + 数据行（Metric 在第 7 列） */
function routeText(rows: { iface: string; destinationHex: string; metric: number }[]): string {
  const lines = ["H"];
  for (const r of rows) lines.push(`${r.iface} ${r.destinationHex} 0 0 0 0 ${r.metric} 0 0 0 0`);
  return lines.join("\n");
}

/** /proc/diskstats 最简构造：字段 3=设备名、字段 6=读扇区、字段 10=写扇区
 *  （其余字段填 0 占位，parseDiskstats 不读它们），无表头（diskstats 本身没有） */
function diskstatsText(rows: { device: string; readSectors: number; writeSectors: number }[]): string {
  return rows
    .map((r, i) => `   8       ${i} ${r.device} 0 0 ${r.readSectors} 0 0 0 ${r.writeSectors} 0`)
    .join("\n");
}

/** 按序返回值的 mock：每次调用推进一格，耗尽后重复最后一个 */
function sequence<T>(values: T[]): () => T {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
}

describe("createHostStatsCollector：1s 内部节拍与差分编排", () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.useFakeTimers();
    db = openDb(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it("首轮只记基线不产帧：tick() 为空、latestFastSamples() 为空对象、denominators 全 null", async () => {
    const collector = createHostStatsCollector({
      db,
      now: sequence([1_000, 2_000]),
      cpus: sequence([[cpuInfo(0, 0)], [cpuInfo(100, 900)]]),
      totalmem: () => 16 * 1024 ** 3,
      freemem: () => 8 * 1024 ** 3,
      loadavg: () => [0.5, 0.3, 0.2],
      readNetDev: async () => null,
      readNetRoute: async () => null,
      statDisk: async () => null,
      readDiskstats: async () => null,
      intervalMs: 1_000,
    });

    collector.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect((await collector.tick())).toEqual([]);
    expect(collector.latestFastSamples()).toEqual({});
    expect(collector.denominators()).toEqual({ cpuCount: null, memTotalBytes: null, diskTotalBytes: null });
    collector.stop();
  });

  it("次轮起产出完整帧：CPU/内存/负载/磁盘/网络全部到位", async () => {
    const collector = createHostStatsCollector({
      db,
      now: sequence([1_000, 2_000]),
      cpus: sequence([[cpuInfo(0, 0)], [cpuInfo(100, 900)]]), // idleΔ100 totalΔ1000 → 90%
      totalmem: () => 16 * 1024 ** 3,
      freemem: () => 4 * 1024 ** 3, // used=12GiB, percent=75%
      loadavg: () => [1.25, 0.8, 0.5],
      readNetDev: async () => netDevText({ eth0: { rx: 1_000, tx: 2_000 } }),
      readNetRoute: async () => routeText([{ iface: "eth0", destinationHex: "00000000", metric: 100 }]),
      statDisk: async () => ({ freeBytes: 100 * 1024 ** 3, totalBytes: 500 * 1024 ** 3 }),
      readDiskstats: async () => null,
      intervalMs: 1_000,
    });

    collector.start();
    await vi.advanceTimersByTimeAsync(2_000); // 两轮：第一轮记基线，第二轮出帧

    const samples = (await collector.tick());
    const byMetric = Object.fromEntries(samples.map((s) => [s.metric, s.value]));
    expect(byMetric[METRIC_IDS.hostCpuPercent]).toBeCloseTo(90, 6);
    expect(byMetric[METRIC_IDS.hostMemUsedBytes]).toBe(12 * 1024 ** 3);
    expect(byMetric[METRIC_IDS.hostMemPercent]).toBeCloseTo(75, 6);
    expect(byMetric[METRIC_IDS.hostLoad1]).toBe(1.25);
    expect(byMetric[METRIC_IDS.hostDiskFreeBytes]).toBe(100 * 1024 ** 3);
    // 两轮间隔 1s（now 1000→2000），eth0 rx/tx 未变——注入的 netDevText 固定值，
    // 说明差分基线在第一轮已经记好；这里改为验证换一组不同计数的场景更能体现差分，
    // 故第二轮换用会变化的 mock（见下一个用例）；本用例先确认字段齐全且非网络字段正确
    expect(collector.denominators()).toEqual({
      cpuCount: 1,
      memTotalBytes: 16 * 1024 ** 3,
      diskTotalBytes: 500 * 1024 ** 3,
    });
    expect(Object.fromEntries(Object.entries(collector.latestFastSamples()).map(([k, v]) => [k, v.value]))).toEqual(
      byMetric,
    );
    collector.stop();
  });

  it("网络速率随计数器差分变化（两轮 rx/tx 均增长）", async () => {
    const netReadings = sequence([
      netDevText({ eth0: { rx: 1_000, tx: 2_000 } }),
      netDevText({ eth0: { rx: 3_000, tx: 2_500 } }), // +2000 rx / +500 tx
    ]);
    const collector = createHostStatsCollector({
      db,
      now: sequence([1_000, 3_000]), // 2s 间隔，便于验证速率换算
      cpus: sequence([[cpuInfo(0, 0)], [cpuInfo(100, 900)]]),
      totalmem: () => 16 * 1024 ** 3,
      freemem: () => 8 * 1024 ** 3,
      loadavg: () => [0, 0, 0],
      readNetDev: async () => netReadings(),
      readNetRoute: async () => routeText([{ iface: "eth0", destinationHex: "00000000", metric: 100 }]),
      statDisk: async () => null,
      readDiskstats: async () => null,
      intervalMs: 1_000,
    });

    collector.start();
    await vi.advanceTimersByTimeAsync(2_000);

    const byMetric = Object.fromEntries((await collector.tick()).map((s) => [s.metric, s.value]));
    expect(byMetric[METRIC_IDS.hostNetRxBytesPerSec]).toBeCloseTo(1_000, 6); // 2000 bytes / 2s
    expect(byMetric[METRIC_IDS.hostNetTxBytesPerSec]).toBeCloseTo(250, 6); // 500 bytes / 2s
    collector.stop();
  });

  it("/proc 未挂载（readNetDev 恒 null）→ 不产网络样本，其余指标照常", async () => {
    const collector = createHostStatsCollector({
      db,
      now: sequence([1_000, 2_000]),
      cpus: sequence([[cpuInfo(0, 0)], [cpuInfo(100, 900)]]),
      totalmem: () => 16 * 1024 ** 3,
      freemem: () => 8 * 1024 ** 3,
      loadavg: () => [0.1, 0.1, 0.1],
      readNetDev: async () => null,
      readNetRoute: async () => null,
      statDisk: async () => ({ freeBytes: 1, totalBytes: 2 }),
      readDiskstats: async () => null,
      intervalMs: 1_000,
    });

    collector.start();
    await vi.advanceTimersByTimeAsync(2_000);

    const metrics = (await collector.tick()).map((s) => s.metric);
    expect(metrics).not.toContain(METRIC_IDS.hostNetRxBytesPerSec);
    expect(metrics).not.toContain(METRIC_IDS.hostNetTxBytesPerSec);
    expect(metrics).toContain(METRIC_IDS.hostCpuPercent);
    expect(metrics).toContain(METRIC_IDS.hostDiskFreeBytes);
    collector.stop();
  });

  it("未提供磁盘读取（statDisk 恒 null）→ 不产磁盘样本，其余指标照常", async () => {
    const collector = createHostStatsCollector({
      db,
      now: sequence([1_000, 2_000]),
      cpus: sequence([[cpuInfo(0, 0)], [cpuInfo(100, 900)]]),
      totalmem: () => 16 * 1024 ** 3,
      freemem: () => 8 * 1024 ** 3,
      loadavg: () => [0.1, 0.1, 0.1],
      readNetDev: async () => null,
      readNetRoute: async () => null,
      statDisk: async () => null,
      readDiskstats: async () => null,
      intervalMs: 1_000,
    });

    collector.start();
    await vi.advanceTimersByTimeAsync(2_000);

    const metrics = (await collector.tick()).map((s) => s.metric);
    expect(metrics).not.toContain(METRIC_IDS.hostDiskFreeBytes);
    expect(collector.denominators().diskTotalBytes).toBeNull();
    collector.stop();
  });

  it("网络计数器重置（第三轮 rx 小于第二轮）→ 该轮不产网络样本，基线更新后第四轮恢复", async () => {
    const netReadings = sequence([
      netDevText({ eth0: { rx: 1_000, tx: 1_000 } }), // 第一轮：记基线
      netDevText({ eth0: { rx: 2_000, tx: 2_000 } }), // 第二轮：正常速率
      netDevText({ eth0: { rx: 100, tx: 100 } }), // 第三轮：计数器重置（网卡重建等）
      netDevText({ eth0: { rx: 600, tx: 600 } }), // 第四轮：以重置后的新基线计算
    ]);
    const collector = createHostStatsCollector({
      db,
      now: sequence([1_000, 2_000, 3_000, 4_000]),
      cpus: sequence([
        [cpuInfo(0, 0)],
        [cpuInfo(100, 900)],
        [cpuInfo(200, 1800)],
        [cpuInfo(300, 2700)],
      ]),
      totalmem: () => 16 * 1024 ** 3,
      freemem: () => 8 * 1024 ** 3,
      loadavg: () => [0, 0, 0],
      readNetDev: async () => netReadings(),
      readNetRoute: async () => routeText([{ iface: "eth0", destinationHex: "00000000", metric: 100 }]),
      statDisk: async () => null,
      readDiskstats: async () => null,
      intervalMs: 1_000,
    });

    collector.start();

    await vi.advanceTimersByTimeAsync(1_000); // 第一轮：基线
    await vi.advanceTimersByTimeAsync(1_000); // 第二轮：1000 bytes/s
    let byMetric = Object.fromEntries((await collector.tick()).map((s) => [s.metric, s.value]));
    expect(byMetric[METRIC_IDS.hostNetRxBytesPerSec]).toBeCloseTo(1_000, 6);

    await vi.advanceTimersByTimeAsync(1_000); // 第三轮：计数器重置
    const metricsAfterReset = (await collector.tick()).map((s) => s.metric);
    expect(metricsAfterReset).not.toContain(METRIC_IDS.hostNetRxBytesPerSec);
    expect(metricsAfterReset).not.toContain(METRIC_IDS.hostNetTxBytesPerSec);

    await vi.advanceTimersByTimeAsync(1_000); // 第四轮：以重置后的基线（100→600）计算
    byMetric = Object.fromEntries((await collector.tick()).map((s) => [s.metric, s.value]));
    expect(byMetric[METRIC_IDS.hostNetRxBytesPerSec]).toBeCloseTo(500, 6);
    collector.stop();
  });

  it("网卡切换（自动选卡结果变化）→ 切换当轮不产速率，重新起算基线", async () => {
    const netReadings = sequence([
      netDevText({ eth0: { rx: 1_000, tx: 1_000 }, eth1: { rx: 5_000, tx: 5_000 } }),
      netDevText({ eth0: { rx: 2_000, tx: 2_000 }, eth1: { rx: 5_100, tx: 5_100 } }),
      netDevText({ eth0: { rx: 2_200, tx: 2_200 }, eth1: { rx: 9_000, tx: 9_000 } }),
      netDevText({ eth0: { rx: 2_400, tx: 2_400 }, eth1: { rx: 9_800, tx: 9_800 } }),
    ]);
    // 前两轮默认路由指向 eth0（metric 更小），第三轮起切到 eth1（metric 反超）
    const routeReadings = sequence([
      routeText([
        { iface: "eth0", destinationHex: "00000000", metric: 100 },
        { iface: "eth1", destinationHex: "00000000", metric: 200 },
      ]),
      routeText([
        { iface: "eth0", destinationHex: "00000000", metric: 100 },
        { iface: "eth1", destinationHex: "00000000", metric: 200 },
      ]),
      routeText([
        { iface: "eth0", destinationHex: "00000000", metric: 300 },
        { iface: "eth1", destinationHex: "00000000", metric: 50 },
      ]),
      routeText([
        { iface: "eth0", destinationHex: "00000000", metric: 300 },
        { iface: "eth1", destinationHex: "00000000", metric: 50 },
      ]),
    ]);
    const collector = createHostStatsCollector({
      db,
      now: sequence([1_000, 2_000, 3_000, 4_000]),
      cpus: sequence([
        [cpuInfo(0, 0)],
        [cpuInfo(100, 900)],
        [cpuInfo(200, 1800)],
        [cpuInfo(300, 2700)],
      ]),
      totalmem: () => 16 * 1024 ** 3,
      freemem: () => 8 * 1024 ** 3,
      loadavg: () => [0, 0, 0],
      readNetDev: async () => netReadings(),
      readNetRoute: async () => routeReadings(),
      statDisk: async () => null,
      readDiskstats: async () => null,
      intervalMs: 1_000,
    });

    collector.start();
    await vi.advanceTimersByTimeAsync(1_000); // 基线（eth0）
    await vi.advanceTimersByTimeAsync(1_000); // 第二轮：仍是 eth0，正常速率 1000 B/s
    let byMetric = Object.fromEntries((await collector.tick()).map((s) => [s.metric, s.value]));
    expect(byMetric[METRIC_IDS.hostNetRxBytesPerSec]).toBeCloseTo(1_000, 6);

    await vi.advanceTimersByTimeAsync(1_000); // 第三轮：切到 eth1，无法与 eth0 的基线相减
    const metricsAfterSwitch = (await collector.tick()).map((s) => s.metric);
    expect(metricsAfterSwitch).not.toContain(METRIC_IDS.hostNetRxBytesPerSec);

    await vi.advanceTimersByTimeAsync(1_000); // 第四轮：eth1 自己的第二次读数，速率恢复
    byMetric = Object.fromEntries((await collector.tick()).map((s) => [s.metric, s.value]));
    expect(byMetric[METRIC_IDS.hostNetRxBytesPerSec]).toBeCloseTo(800, 6); // 9800-9000
    collector.stop();
  });

  it("用户在 settings 指定具体网卡 → 使用它而非自动选择结果", async () => {
    saveHostNetIfacePreference(db, "eth1");
    const netReadings = sequence([
      netDevText({ eth0: { rx: 1_000, tx: 1_000 }, eth1: { rx: 10_000, tx: 10_000 } }),
      netDevText({ eth0: { rx: 2_000, tx: 2_000 }, eth1: { rx: 10_500, tx: 10_500 } }),
    ]);
    const collector = createHostStatsCollector({
      db,
      now: sequence([1_000, 2_000]),
      cpus: sequence([[cpuInfo(0, 0)], [cpuInfo(100, 900)]]),
      totalmem: () => 16 * 1024 ** 3,
      freemem: () => 8 * 1024 ** 3,
      loadavg: () => [0, 0, 0],
      readNetDev: async () => netReadings(),
      // 默认路由指向 eth0（若忽略用户偏好会错误选中它）
      readNetRoute: async () => routeText([{ iface: "eth0", destinationHex: "00000000", metric: 100 }]),
      statDisk: async () => null,
      readDiskstats: async () => null,
      intervalMs: 1_000,
    });

    collector.start();
    await vi.advanceTimersByTimeAsync(2_000);

    const byMetric = Object.fromEntries((await collector.tick()).map((s) => [s.metric, s.value]));
    expect(byMetric[METRIC_IDS.hostNetRxBytesPerSec]).toBeCloseTo(500, 6); // eth1: 10500-10000
    collector.stop();
  });

  it("start()/stop() 幂等；stop 后不再采样", async () => {
    const cpuSeq = sequence([[cpuInfo(0, 0)], [cpuInfo(100, 900)], [cpuInfo(300, 2700)]]);
    const collector = createHostStatsCollector({
      db,
      now: sequence([1_000, 2_000, 3_000]),
      cpus: cpuSeq,
      totalmem: () => 16 * 1024 ** 3,
      freemem: () => 8 * 1024 ** 3,
      loadavg: () => [0, 0, 0],
      readNetDev: async () => null,
      readNetRoute: async () => null,
      statDisk: async () => null,
      readDiskstats: async () => null,
      intervalMs: 1_000,
    });

    collector.start();
    collector.start(); // 幂等
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await collector.tick()).length).toBeGreaterThan(0);

    collector.stop();
    const beforeStop = (await collector.tick());
    collector.stop(); // 幂等
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await collector.tick())).toEqual(beforeStop); // stop 后不再更新
  });

  it("磁盘 IO 速率随扇区计数器差分变化（两轮 read/write 均增长）", async () => {
    const diskReadings = sequence([
      diskstatsText([{ device: "sda", readSectors: 1_000, writeSectors: 2_000 }]),
      diskstatsText([{ device: "sda", readSectors: 3_000, writeSectors: 2_500 }]), // +2000 读 / +500 写
    ]);
    const collector = createHostStatsCollector({
      db,
      now: sequence([1_000, 3_000]), // 2s 间隔，便于验证速率换算
      cpus: sequence([[cpuInfo(0, 0)], [cpuInfo(100, 900)]]),
      totalmem: () => 16 * 1024 ** 3,
      freemem: () => 8 * 1024 ** 3,
      loadavg: () => [0, 0, 0],
      readNetDev: async () => null,
      readNetRoute: async () => null,
      statDisk: async () => null,
      readDiskstats: async () => diskReadings(),
      intervalMs: 1_000,
    });

    collector.start();
    await vi.advanceTimersByTimeAsync(2_000);

    const byMetric = Object.fromEntries((await collector.tick()).map((s) => [s.metric, s.value]));
    // 读：2000 扇区 × 512 字节 / 2s = 512000 B/s；写：500 扇区 × 512 字节 / 2s = 128000 B/s
    expect(byMetric[METRIC_IDS.hostDiskReadBytesPerSec]).toBeCloseTo(512_000, 6);
    expect(byMetric[METRIC_IDS.hostDiskWriteBytesPerSec]).toBeCloseTo(128_000, 6);
    collector.stop();
  });

  it("/host/proc/diskstats 未挂载（readDiskstats 恒 null）→ 不产磁盘 IO 样本，其余指标照常", async () => {
    const collector = createHostStatsCollector({
      db,
      now: sequence([1_000, 2_000]),
      cpus: sequence([[cpuInfo(0, 0)], [cpuInfo(100, 900)]]),
      totalmem: () => 16 * 1024 ** 3,
      freemem: () => 8 * 1024 ** 3,
      loadavg: () => [0.1, 0.1, 0.1],
      readNetDev: async () => null,
      readNetRoute: async () => null,
      statDisk: async () => ({ freeBytes: 1, totalBytes: 2 }),
      readDiskstats: async () => null,
      intervalMs: 1_000,
    });

    collector.start();
    await vi.advanceTimersByTimeAsync(2_000);

    const metrics = (await collector.tick()).map((s) => s.metric);
    expect(metrics).not.toContain(METRIC_IDS.hostDiskReadBytesPerSec);
    expect(metrics).not.toContain(METRIC_IDS.hostDiskWriteBytesPerSec);
    expect(metrics).toContain(METRIC_IDS.hostCpuPercent);
    expect(metrics).toContain(METRIC_IDS.hostDiskFreeBytes); // D2：磁盘剩余字段不受影响，照常产出
    collector.stop();
  });

  it("diskstats 里选不出物理盘（全是 loop 设备）→ 不产磁盘 IO 样本，其余指标照常", async () => {
    const collector = createHostStatsCollector({
      db,
      now: sequence([1_000, 2_000]),
      cpus: sequence([[cpuInfo(0, 0)], [cpuInfo(100, 900)]]),
      totalmem: () => 16 * 1024 ** 3,
      freemem: () => 8 * 1024 ** 3,
      loadavg: () => [0, 0, 0],
      readNetDev: async () => null,
      readNetRoute: async () => null,
      statDisk: async () => null,
      readDiskstats: async () => diskstatsText([{ device: "loop0", readSectors: 100, writeSectors: 0 }]),
      intervalMs: 1_000,
    });

    collector.start();
    await vi.advanceTimersByTimeAsync(2_000);

    const metrics = (await collector.tick()).map((s) => s.metric);
    expect(metrics).not.toContain(METRIC_IDS.hostDiskReadBytesPerSec);
    expect(metrics).not.toContain(METRIC_IDS.hostDiskWriteBytesPerSec);
    expect(metrics).toContain(METRIC_IDS.hostCpuPercent);
    collector.stop();
  });

  it("磁盘计数器重置（第三轮 read 小于第二轮）→ 该轮不产磁盘 IO 样本，基线更新后第四轮恢复", async () => {
    const diskReadings = sequence([
      diskstatsText([{ device: "sda", readSectors: 1_000, writeSectors: 1_000 }]), // 第一轮：记基线
      diskstatsText([{ device: "sda", readSectors: 2_000, writeSectors: 2_000 }]), // 第二轮：正常速率
      diskstatsText([{ device: "sda", readSectors: 100, writeSectors: 100 }]), // 第三轮：计数器重置
      diskstatsText([{ device: "sda", readSectors: 600, writeSectors: 600 }]), // 第四轮：以重置后的新基线计算
    ]);
    const collector = createHostStatsCollector({
      db,
      now: sequence([1_000, 2_000, 3_000, 4_000]),
      cpus: sequence([
        [cpuInfo(0, 0)],
        [cpuInfo(100, 900)],
        [cpuInfo(200, 1800)],
        [cpuInfo(300, 2700)],
      ]),
      totalmem: () => 16 * 1024 ** 3,
      freemem: () => 8 * 1024 ** 3,
      loadavg: () => [0, 0, 0],
      readNetDev: async () => null,
      readNetRoute: async () => null,
      statDisk: async () => null,
      readDiskstats: async () => diskReadings(),
      intervalMs: 1_000,
    });

    collector.start();

    await vi.advanceTimersByTimeAsync(1_000); // 第一轮：基线
    await vi.advanceTimersByTimeAsync(1_000); // 第二轮：1000 扇区 × 512 / 1s = 512000 B/s
    let byMetric = Object.fromEntries((await collector.tick()).map((s) => [s.metric, s.value]));
    expect(byMetric[METRIC_IDS.hostDiskReadBytesPerSec]).toBeCloseTo(512_000, 6);

    await vi.advanceTimersByTimeAsync(1_000); // 第三轮：计数器重置
    const metricsAfterReset = (await collector.tick()).map((s) => s.metric);
    expect(metricsAfterReset).not.toContain(METRIC_IDS.hostDiskReadBytesPerSec);
    expect(metricsAfterReset).not.toContain(METRIC_IDS.hostDiskWriteBytesPerSec);

    await vi.advanceTimersByTimeAsync(1_000); // 第四轮：以重置后的基线（100→600）计算，500 扇区 × 512 / 1s
    byMetric = Object.fromEntries((await collector.tick()).map((s) => [s.metric, s.value]));
    expect(byMetric[METRIC_IDS.hostDiskReadBytesPerSec]).toBeCloseTo(256_000, 6);
    collector.stop();
  });
});
