import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb, runMigrations } from "../db";
import { createMetricsStore, MAX_POINTS, type MetricsStore } from "./store";
import { METRIC_IDS } from "./ids";

/**
 * 指标管线测试（M3 Task 3，TDD）
 *
 * 时间全部走注入的 now（变量时钟，毫秒），不依赖 fake timers——
 * flush / rollup 由测试手动调用（生产才走 startFlushTimers 调度）。
 * T0 = 2026-01-01T00:00:00Z，毫秒值同时被 60s / 900s 整除，
 * 分钟桶与 15min 桶的窗口起点都落在 T0 上，断言不必做取整换算。
 */

const T0 = new Date("2026-01-01T00:00:00Z").getTime();
const SEC = 1_000;
const MIN = 60 * SEC;

interface BucketRow {
  metric_id: string;
  granularity: number;
  bucket_start: number;
  min: number;
  max: number;
  avg: number;
  count: number;
}

/** 直插一行桶（构造 rollup / 清理用例的既有数据） */
function insertBucket(
  db: Database.Database,
  row: Omit<BucketRow, "min" | "max" | "avg" | "count"> & { min: number; max: number; avg: number; count: number },
): void {
  db.prepare(
    "INSERT OR REPLACE INTO metrics_bucket(metric_id, granularity, bucket_start, min, max, avg, count) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(row.metric_id, row.granularity, row.bucket_start, row.min, row.max, row.avg, row.count);
}

function allBuckets(db: Database.Database): BucketRow[] {
  return db
    .prepare("SELECT metric_id, granularity, bucket_start, min, max, avg, count FROM metrics_bucket ORDER BY metric_id, granularity, bucket_start")
    .all() as BucketRow[];
}

let db: Database.Database;
let clock: number;
let store: MetricsStore;

beforeEach(() => {
  db = openDb(":memory:");
  runMigrations(db);
  clock = T0;
  store = createMetricsStore(db, { now: () => clock });
});

afterEach(() => {
  db.close();
});

describe("内存 ring", () => {
  it("push 多样本后 queryRange(from) 只含 ts≥from 的点且按 ts 升序", () => {
    for (let i = 0; i < 10; i++) {
      store.push({ metric: METRIC_IDS.containerCpuPercent, value: i, ts: T0 + i * 5_000 });
    }
    const series = store.queryRange(T0 + 20_000)[METRIC_IDS.containerCpuPercent];
    expect(series.map((p) => p.ts)).toEqual([
      T0 + 20_000, T0 + 25_000, T0 + 30_000, T0 + 35_000, T0 + 40_000, T0 + 45_000,
    ]);
    expect(series.map((p) => p.value)).toEqual([4, 5, 6, 7, 8, 9]);
  });

  it("多指标互不串扰，各自成序列", () => {
    store.push({ metric: METRIC_IDS.containerCpuPercent, value: 1, ts: T0 });
    store.push({ metric: METRIC_IDS.gpuUtilPercent, value: 2, ts: T0 });
    const result = store.queryRange(T0);
    expect(Object.keys(result).sort()).toEqual([METRIC_IDS.containerCpuPercent, METRIC_IDS.gpuUtilPercent]);
    expect(result[METRIC_IDS.containerCpuPercent]).toEqual([{ ts: T0, value: 1 }]);
    expect(result[METRIC_IDS.gpuUtilPercent]).toEqual([{ ts: T0, value: 2 }]);
  });

  it("容量封顶：推 2000 个点只保留最近 MAX_POINTS=1440 个（丢最旧）", () => {
    for (let i = 0; i < 2_000; i++) {
      store.push({ metric: METRIC_IDS.containerCpuPercent, value: i, ts: T0 + i * 5_000 });
    }
    const series = store.queryRange(0)[METRIC_IDS.containerCpuPercent];
    expect(series).toHaveLength(MAX_POINTS);
    expect(MAX_POINTS).toBe(1_440); // 2h / 5s
    expect(series[0]).toEqual({ ts: T0 + 560 * 5_000, value: 560 }); // 最旧 560 个被挤掉
    expect(series[series.length - 1]).toEqual({ ts: T0 + 1_999 * 5_000, value: 1_999 });
  });
});

describe("分钟累加器与 flushMinuteBuckets", () => {
  it("同一分钟内多 push 累积 min/max/sum/count，分钟翻转后 flush 落盘 granularity=1 整点秒桶", () => {
    store.push({ metric: METRIC_IDS.containerCpuPercent, value: 10, ts: T0 });
    store.push({ metric: METRIC_IDS.containerCpuPercent, value: 40, ts: T0 + 20_000 });
    store.push({ metric: METRIC_IDS.containerCpuPercent, value: 20, ts: T0 + 40_000 });

    clock = T0 + 61_000; // 跨入下一分钟，旧分钟累加器留在待 flush 状态
    store.push({ metric: METRIC_IDS.containerCpuPercent, value: 99, ts: clock }); // 新分钟的样本

    store.flushMinuteBuckets();

    const rows = allBuckets(db).filter((r) => r.granularity === 1);
    expect(rows).toHaveLength(1); // 新分钟未结束，不落盘
    expect(rows[0]).toEqual({
      metric_id: METRIC_IDS.containerCpuPercent,
      granularity: 1,
      bucket_start: T0 / SEC, // 分钟整点（秒）
      min: 10,
      max: 40,
      avg: (10 + 40 + 20) / 3,
      count: 3,
    });
  });

  it("分钟未结束时 flush 不写当前半截分钟", () => {
    store.push({ metric: METRIC_IDS.containerCpuPercent, value: 5, ts: T0 + 10_000 });
    store.flushMinuteBuckets(); // clock 仍在第一分钟内
    expect(allBuckets(db)).toHaveLength(0);
  });

  it("flush 后累加器清空：重复 flush 幂等不重复写", () => {
    store.push({ metric: METRIC_IDS.inferTokensPerSec, value: 7, ts: T0 + 30_000 });
    clock = T0 + MIN;
    store.flushMinuteBuckets();
    store.flushMinuteBuckets(); // 累加器已清空
    const rows = allBuckets(db).filter((r) => r.granularity === 1);
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(1);
    expect(rows[0].avg).toBe(7);
  });
});

describe("rollup15AndPurge", () => {
  const W0 = T0 / SEC; // 第一个 15min 窗口起点（秒）

  it("1min 桶 rollup 成 15min 桶：avg 按 count 加权，多指标各自成行", () => {
    // m1：窗口 W0 内两分钟桶，加权 avg = (10*2 + 20*1)/3
    insertBucket(db, { metric_id: METRIC_IDS.containerCpuPercent, granularity: 1, bucket_start: W0, min: 1, max: 11, avg: 10, count: 2 });
    insertBucket(db, { metric_id: METRIC_IDS.containerCpuPercent, granularity: 1, bucket_start: W0 + 60, min: 18, max: 22, avg: 20, count: 1 });
    // m2：同窗口另一指标
    insertBucket(db, { metric_id: METRIC_IDS.gpuUtilPercent, granularity: 1, bucket_start: W0, min: 3, max: 3, avg: 3, count: 5 });

    clock = T0 + 15 * MIN; // 窗口 W0 已完整结束
    store.rollup15AndPurge();

    const rows = allBuckets(db).filter((r) => r.granularity === 15);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      metric_id: METRIC_IDS.containerCpuPercent,
      granularity: 15,
      bucket_start: W0,
      min: 1,
      max: 22,
      avg: (10 * 2 + 20 * 1) / 3,
      count: 3,
    });
    expect(rows[1]).toEqual({
      metric_id: METRIC_IDS.gpuUtilPercent,
      granularity: 15,
      bucket_start: W0,
      min: 3,
      max: 3,
      avg: 3,
      count: 5,
    });
  });

  it("未完整结束的 15min 窗口不 rollup（半截窗口不出行）", () => {
    insertBucket(db, { metric_id: METRIC_IDS.containerCpuPercent, granularity: 1, bucket_start: W0, min: 1, max: 1, avg: 1, count: 1 });
    clock = T0 + 10 * MIN; // 窗口还差 5min 才结束
    store.rollup15AndPurge();
    expect(allBuckets(db).filter((r) => r.granularity === 15)).toHaveLength(0);
  });

  it("重跑 rollup 幂等：已有 15min 桶不重复、不被写坏", () => {
    insertBucket(db, { metric_id: METRIC_IDS.containerCpuPercent, granularity: 1, bucket_start: W0, min: 4, max: 8, avg: 6, count: 2 });
    clock = T0 + 15 * MIN;
    store.rollup15AndPurge();
    store.rollup15AndPurge(); // 重跑

    const rows = allBuckets(db).filter((r) => r.granularity === 15);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      metric_id: METRIC_IDS.containerCpuPercent,
      granularity: 15,
      bucket_start: W0,
      min: 4,
      max: 8,
      avg: 6,
      count: 2,
    });
  });

  it("过期清理：49h 前的 1min 桶与 15d 前的 15min 桶被删，48h 内 / 14d 内保留", () => {
    const HOUR = 3_600;
    const DAY = 24 * HOUR;
    const nowSec = T0 / SEC + 20 * DAY; // 任取一个"现在"
    clock = nowSec * SEC;

    insertBucket(db, { metric_id: METRIC_IDS.containerCpuPercent, granularity: 1, bucket_start: nowSec - 49 * HOUR, min: 0, max: 0, avg: 0, count: 1 }); // 过期
    insertBucket(db, { metric_id: METRIC_IDS.containerCpuPercent, granularity: 1, bucket_start: nowSec - 47 * HOUR, min: 1, max: 1, avg: 1, count: 1 }); // 保留
    insertBucket(db, { metric_id: METRIC_IDS.gpuUtilPercent, granularity: 15, bucket_start: nowSec - 15 * DAY, min: 0, max: 0, avg: 0, count: 1 }); // 过期
    insertBucket(db, { metric_id: METRIC_IDS.gpuUtilPercent, granularity: 15, bucket_start: nowSec - 13 * DAY, min: 2, max: 2, avg: 2, count: 1 }); // 保留

    store.rollup15AndPurge();

    // 保留期内的 1min 桶会被 rollup 出对应 15min 桶（管线语义），逐行核对而非只数总数
    const rows = allBuckets(db);
    const starts = rows.map((r) => `${r.metric_id}:${r.granularity}:${r.bucket_start}`);
    expect(starts).toContain(`${METRIC_IDS.containerCpuPercent}:1:${nowSec - 47 * HOUR}`);
    expect(starts).toContain(`${METRIC_IDS.gpuUtilPercent}:15:${nowSec - 13 * DAY}`);
    // 47h 桶所在 15min 窗口已完整结束 → rollup 产物存在
    expect(starts).toContain(
      `${METRIC_IDS.containerCpuPercent}:15:${Math.floor((nowSec - 47 * HOUR) / 900) * 900}`,
    );
    // 过期行被删
    expect(starts).not.toContain(`${METRIC_IDS.containerCpuPercent}:1:${nowSec - 49 * HOUR}`);
    expect(starts).not.toContain(`${METRIC_IDS.gpuUtilPercent}:15:${nowSec - 15 * DAY}`);
    expect(rows).toHaveLength(3); // 1min×1 + 15min×2
  });
});

describe("queryRange 自动降源（重启语义）", () => {
  const W0 = T0 / SEC;

  it("ring 有点且 from ≥ ring 最老点 → 纯 ring（不掺桶点）", () => {
    // 第一分钟样本 flush + rollup 出一个 15min 桶点（ts = T0）
    store.push({ metric: METRIC_IDS.containerCpuPercent, value: 10, ts: T0 });
    store.push({ metric: METRIC_IDS.containerCpuPercent, value: 20, ts: T0 + 30_000 });
    clock = T0 + MIN;
    store.flushMinuteBuckets();
    clock = T0 + 15 * MIN;
    store.rollup15AndPurge();
    // 第二个窗口再推 ring 点（更晚）
    store.push({ metric: METRIC_IDS.containerCpuPercent, value: 30, ts: T0 + 15 * MIN + 5_000 });

    // from ≥ ring 最老点（T0）→ 纯 ring，绝不含 15min 桶 avg 点
    const series = store.queryRange(T0)[METRIC_IDS.containerCpuPercent];
    expect(series).toEqual([
      { ts: T0, value: 10 },
      { ts: T0 + 30_000, value: 20 },
      { ts: T0 + 15 * MIN + 5_000, value: 30 },
    ]);
  });

  it("from 早于 ring 最老点 → ring 点 + 15min 桶 avg 点按 ts 合并去重（同 ts 时 ring 优先）", () => {
    // 窗口 W0 的桶点（ts = T0，avg = 15）
    store.push({ metric: METRIC_IDS.containerCpuPercent, value: 10, ts: T0 });
    store.push({ metric: METRIC_IDS.containerCpuPercent, value: 20, ts: T0 + 30_000 });
    clock = T0 + MIN;
    store.flushMinuteBuckets();
    clock = T0 + 15 * MIN;
    store.rollup15AndPurge();
    // 重启等价：新建 store，ring 从零开始，只有窗口 W1 之后的新样本
    const storeB = createMetricsStore(db, { now: () => clock });
    storeB.push({ metric: METRIC_IDS.containerCpuPercent, value: 40, ts: T0 + 16 * MIN });
    storeB.push({ metric: METRIC_IDS.containerCpuPercent, value: 50, ts: T0 + 17 * MIN });

    // from = T0 - 2h，早于 ringB 最老点（T0+16min）→ 混拼：桶点(T0) + ring 点
    const series = storeB.queryRange(T0 - 2 * 3_600_000)[METRIC_IDS.containerCpuPercent];
    expect(series).toEqual([
      { ts: W0 * SEC, value: 15 }, // 15min 桶 avg 点，bucket_start*1000 为 ts
      { ts: T0 + 16 * MIN, value: 40 },
      { ts: T0 + 17 * MIN, value: 50 },
    ]);
  });

  it("重启后 ring 空：queryRange 走桶（15min 桶点）；期间无桶点则空对象", () => {
    store.push({ metric: METRIC_IDS.inferKvCacheTokens, value: 100, ts: T0 + 10_000 });
    store.push({ metric: METRIC_IDS.inferKvCacheTokens, value: 200, ts: T0 + 50_000 });
    clock = T0 + MIN;
    store.flushMinuteBuckets();
    clock = T0 + 15 * MIN;
    store.rollup15AndPurge();

    const storeB = createMetricsStore(db, { now: () => clock });
    // 短窗（ring 语义）查询：ringB 无点 → 只有桶点可回
    const series = storeB.queryRange(T0)[METRIC_IDS.inferKvCacheTokens];
    expect(series).toEqual([{ ts: W0 * SEC, value: 150 }]);

    // 尚未 rollup 的更近窗口：ringB 也无点 → 空对象（图表断点间隙）
    storeB.push({ metric: METRIC_IDS.inferKvCacheTokens, value: 1, ts: clock + 5_000 });
    const empty = storeB.queryRange(clock);
    expect(empty[METRIC_IDS.inferKvCacheTokens]).toEqual([{ ts: clock + 5_000, value: 1 }]);
    expect(storeB.queryRange(clock + 10_000)).toEqual({}); // from 晚于 ring 唯一点且无桶可回
  });
});

describe("边界防御", () => {
  it("空 ring + 空桶 → queryRange 返回空对象", () => {
    expect(store.queryRange(T0 - 3_600_000)).toEqual({});
  });

  it("负值 / NaN / 非有限值样本丢弃：不进 ring 也不进累加器", () => {
    store.push({ metric: METRIC_IDS.containerCpuPercent, value: -1, ts: T0 });
    store.push({ metric: METRIC_IDS.containerCpuPercent, value: Number.NaN, ts: T0 + 5_000 });
    store.push({ metric: METRIC_IDS.containerCpuPercent, value: Number.POSITIVE_INFINITY, ts: T0 + 10_000 });
    expect(store.queryRange(0)).toEqual({});

    clock = T0 + MIN;
    store.flushMinuteBuckets();
    clock = T0 + 15 * MIN;
    store.rollup15AndPurge();
    expect(allBuckets(db)).toHaveLength(0);
  });
});

describe("aggregateRange（U17 T1：run 结束回填用的区间聚合）", () => {
  const M = METRIC_IDS.inferTokensPerSec;

  it("纯 ring 场景：数据尚未 flush，直接从 ring 聚合", () => {
    store.push({ metric: M, value: 10, ts: T0 });
    store.push({ metric: M, value: 30, ts: T0 + 20_000 });
    store.push({ metric: M, value: 20, ts: T0 + 40_000 });

    const result = store.aggregateRange(M, T0, T0 + 59_000);
    expect(result).toEqual({ max: 30, avg: (10 + 30 + 20) / 3, count: 3 });
  });

  it("纯桶场景：区间全在已 flush 的历史里，ring 尾部不重叠", () => {
    store.push({ metric: M, value: 10, ts: T0 });
    store.push({ metric: M, value: 40, ts: T0 + 20_000 });
    store.push({ metric: M, value: 20, ts: T0 + 40_000 });
    clock = T0 + MIN;
    store.flushMinuteBuckets();

    const result = store.aggregateRange(M, T0, T0 + 59_000);
    expect(result).toEqual({ max: 40, avg: (10 + 40 + 20) / 3, count: 3 });
  });

  it("混合场景且不重复计入（对齐场景：fromTs 落在分钟整点上，与下方两条非对齐用例互补）", () => {
    // 第一分钟：3 个样本，flush 成 1min 桶（count=3, avg=(10+40+20)/3, max=40）
    store.push({ metric: M, value: 10, ts: T0 });
    store.push({ metric: M, value: 40, ts: T0 + 20_000 });
    store.push({ metric: M, value: 20, ts: T0 + 40_000 });
    clock = T0 + MIN;
    store.flushMinuteBuckets();

    // 第二分钟：2 个样本，尚未到下一次 flush 时机，仍留在 ring 里
    store.push({ metric: M, value: 100, ts: T0 + MIN + 5_000 });
    store.push({ metric: M, value: 5, ts: T0 + MIN + 10_000 });

    const result = store.aggregateRange(M, T0, T0 + MIN + 20_000);

    // 核心断言：count = 桶 count(3) + 未 flush 的 ring 点数(2) = 5，
    // 而不是把已 flush 那段的 3 个原始点又从 ring 里算一遍（会变成 8）
    expect(result?.count).toBe(5);
    expect(result?.max).toBe(100);
    expect(result?.avg).toBeCloseTo((10 + 40 + 20 + 100 + 5) / 5);
  });

  it("fromTs 不对齐分钟整点时，首个不完整分钟的峰值不丢", () => {
    // 峰值 999 落在首个不完整分钟（T0~T0+60s）里、且在 from 之后；
    // 该分钟的桶起点 T0 早于 from，会被 SQL 整行排除——若 ring 不补前段，
    // 999 会两路皆空（这正是主进程复核发现的缺陷场景）。
    const from = T0 + 30_000;
    store.push({ metric: M, value: 999, ts: T0 + 30_000 });
    store.push({ metric: M, value: 10, ts: T0 + 70_000 });
    store.push({ metric: M, value: 20, ts: T0 + 130_000 });
    clock = T0 + 180_000;
    store.flushMinuteBuckets(); // 三个 1min 桶：T0 / T0+60s / T0+120s 均已结束

    const result = store.aggregateRange(M, from, T0 + 180_000);
    expect(result?.max).toBe(999);
    expect(result?.count).toBe(3);
  });

  it("非对齐场景下前段补齐不与桶重复计入：count = 前段 ring 点数 + 入选桶 count 之和 + 后段 ring 点数", () => {
    const from = T0 + 45_000; // 落在第一分钟（T0~T0+60s）中间，该分钟桶会被 SQL 排除
    store.push({ metric: M, value: 1, ts: T0 + 10_000 }); // from 之前：不属于查询区间，不计入任何一段
    store.push({ metric: M, value: 50, ts: T0 + 45_000 }); // 前段 ring：与 from 同一分钟、from 之后
    store.push({ metric: M, value: 60, ts: T0 + 50_000 }); // 前段 ring
    store.push({ metric: M, value: 5, ts: T0 + 70_000 }); // 第二分钟：会被 flush 成桶
    store.push({ metric: M, value: 7, ts: T0 + 90_000 }); // 第二分钟：同上

    clock = T0 + 120_000; // 前两个分钟均已结束
    store.flushMinuteBuckets();

    store.push({ metric: M, value: 100, ts: T0 + 125_000 }); // 后段 ring：第三分钟尚未 flush
    store.push({ metric: M, value: 3, ts: T0 + 135_000 }); // 后段 ring

    const result = store.aggregateRange(M, from, T0 + 150_000);

    const frontRingCount = 2; // T0+45s, T0+50s
    const selectedBucketCount = 2; // 第二分钟那个桶：count=2（第一分钟的桶起点早于 from 被排除）
    const tailRingCount = 2; // T0+125s, T0+135s
    expect(result?.count).toBe(frontRingCount + selectedBucketCount + tailRingCount);
    expect(result?.max).toBe(100);
    expect(result?.avg).toBeCloseTo((50 + 60 + 5 + 7 + 100 + 3) / 6);
  });

  it("区间外的点不计入", () => {
    store.push({ metric: M, value: 999, ts: T0 - 5_000 }); // 区间之前
    store.push({ metric: M, value: 10, ts: T0 });
    store.push({ metric: M, value: 20, ts: T0 + 30_000 });
    store.push({ metric: M, value: 999, ts: T0 + 5 * MIN }); // 区间之后

    const result = store.aggregateRange(M, T0, T0 + MIN);
    expect(result).toEqual({ max: 20, avg: 15, count: 2 });
  });

  it("无数据（ring 与桶均无该指标）→ null", () => {
    expect(store.aggregateRange(M, T0, T0 + MIN)).toBeNull();
  });
});
