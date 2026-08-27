import type Database from "better-sqlite3";

/**
 * 指标管线存储（M3 Task 3，设计 §9.1）
 *
 * 双层数据路径：
 * - 内存 ring：每指标最近 2h / 5s 分辨率的原始点，dashboard 实时图直读；
 *   面板重启即丢（ring 重建，历史靠桶，图表呈现断点间隙）
 * - SQLite 聚合桶（metrics_bucket，migration v3）：每分钟把"已完整结束分钟"的
 *   累加器落盘为 granularity=1 桶（保留 48h）；由 1min 桶 rollup 出
 *   granularity=15 桶（保留 14d）；过期清理随 rollup 循环执行
 *
 * queryRange 自动降源（规则锚定）：
 * - ring 有点且 from ≥ ring 最老点 → 纯 ring（5s 细分辨率优先）
 * - 否则（含 ring 为空的重启场景）→ ring 点 + 15min 桶 avg 点
 *   （bucket_start*1000 为 ts、avg 为 value）按 ts 升序合并，同 ts 时 ring 优先
 *
 * 生产调度走 startFlushTimers（60s flush + 15min rollup）；测试注入 now 手动驱动。
 */

/** ring 容量：2h / 5s = 1440 点/指标（超限丢最旧） */
export const MAX_POINTS = 1_440;

/** 1min 桶保留窗口（秒）：48h */
const RETENTION_1MIN_SEC = 48 * 3_600;
/** 15min 桶保留窗口（秒）：14d */
const RETENTION_15MIN_SEC = 14 * 24 * 3_600;

/** 采样点（消费侧口径：metric 放宽为 string，兼容 ids.ts 的 MetricId 样本） */
export interface Sample {
  metric: string;
  value: number;
  /** 毫秒时间戳 */
  ts: number;
}

/** 分钟累加器：flush 前在内存累积，落盘时换算出 min/max/avg/count */
interface MinuteAcc {
  min: number;
  max: number;
  sum: number;
  count: number;
}

export interface MetricsStore {
  /** 写入一个样本：进 ring + 分钟累加器；非法值（负值/NaN/非有限）防御性丢弃 */
  push(sample: Sample): void;
  /** 查询 from（毫秒）之后的序列，自动降源（见文件头注释） */
  queryRange(fromTs: number): { [metric: string]: { ts: number; value: number }[] };
  /** 把已完整结束分钟的累加器写为 granularity=1 桶，并清空对应累加器（幂等） */
  flushMinuteBuckets(): void;
  /** 已完整结束 15min 窗口 rollup 为 granularity=15 桶 + 过期清理（幂等） */
  rollup15AndPurge(): void;
  /**
   * 区间聚合（run 结束时回填用，U17 T1）：[fromTs, toTs] 毫秒闭区间。
   * 先取该区间内已 flush 的 1min 桶，再补 ring 里尚未 flush 的尾部点，
   * 两路不重叠（见实现处注释）。区间内无任何数据 → null。
   */
  aggregateRange(
    metric: string,
    fromTs: number,
    toTs: number,
  ): { max: number; avg: number; count: number } | null;
  /** 生产调度：60s flush + 15min rollup（测试不启动，手动调上面两个方法） */
  startFlushTimers(): void;
  stopFlushTimers(): void;
}

export function createMetricsStore(
  db: Database.Database,
  opts?: { now?: () => number },
): MetricsStore {
  const now = opts?.now ?? Date.now;

  // ---- 状态 ----
  /** 内存 ring：指标 → 按 ts 升序的点列（push 天然升序，容量超限从头丢弃） */
  const ring = new Map<string, { ts: number; value: number }[]>();
  /** 分钟累加器：指标 → 分钟起点（秒级整点）→ 累加值；flush 只取"分钟已结束"的条目 */
  const minutes = new Map<string, Map<number, MinuteAcc>>();

  // ---- prepared statements ----
  const insertBucket = db.prepare(
    "INSERT OR REPLACE INTO metrics_bucket(metric_id, granularity, bucket_start, min, max, avg, count) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const select1minBuckets = db.prepare(
    "SELECT metric_id, bucket_start, min, max, avg, count FROM metrics_bucket WHERE granularity = 1 AND bucket_start >= ?",
  );
  const select15minFrom = db.prepare(
    "SELECT metric_id, bucket_start, avg FROM metrics_bucket WHERE granularity = 15 AND bucket_start >= ? ORDER BY metric_id, bucket_start",
  );
  const purge1min = db.prepare(
    "DELETE FROM metrics_bucket WHERE granularity = 1 AND bucket_start < ?",
  );
  const purge15min = db.prepare(
    "DELETE FROM metrics_bucket WHERE granularity = 15 AND bucket_start < ?",
  );
  // bucket_start 是秒级整点，与入参的毫秒 fromTs/toTs 比较前换算成毫秒，
  // 避免调用方各自做取整换算（也避免整除取整引入的边界误差）。
  const selectBucketsForRange = db.prepare(
    "SELECT bucket_start, max, avg, count FROM metrics_bucket WHERE metric_id = ? AND granularity = 1 AND bucket_start * 1000 >= ? AND bucket_start * 1000 <= ? ORDER BY bucket_start",
  );

  function push(sample: Sample): void {
    // 防御：本仓库所有指标均为非负量（百分比/字节/tokens），负值或非有限值直接丢弃
    if (!Number.isFinite(sample.value) || sample.value < 0) return;
    if (!Number.isFinite(sample.ts) || typeof sample.metric !== "string" || sample.metric === "") return;

    // ring：追加并容量封顶（丢最旧）
    let points = ring.get(sample.metric);
    if (!points) {
      points = [];
      ring.set(sample.metric, points);
    }
    points.push({ ts: sample.ts, value: sample.value });
    if (points.length > MAX_POINTS) points.splice(0, points.length - MAX_POINTS);

    // 分钟累加器：按样本 ts 所在分钟归集（迟到样本落回其所属分钟，flush 前不丢）
    const minuteStartSec = Math.floor(sample.ts / 60_000) * 60; // 秒级分钟整点
    let byMinute = minutes.get(sample.metric);
    if (!byMinute) {
      byMinute = new Map();
      minutes.set(sample.metric, byMinute);
    }
    const acc = byMinute.get(minuteStartSec);
    if (acc) {
      acc.min = Math.min(acc.min, sample.value);
      acc.max = Math.max(acc.max, sample.value);
      acc.sum += sample.value;
      acc.count += 1;
    } else {
      byMinute.set(minuteStartSec, { min: sample.value, max: sample.value, sum: sample.value, count: 1 });
    }
  }

  function queryRange(fromTs: number): { [metric: string]: { ts: number; value: number }[] } {
    // 15min 桶候选：包含 from 所在窗口起的桶（窗口部分早于 from 也纳入，图表容忍）
    const fromWindow = Math.floor(fromTs / 1_000 / 900) * 900;
    const byMetricBuckets = new Map<string, { ts: number; value: number }[]>();
    for (const row of select15minFrom.all(fromWindow) as { metric_id: string; bucket_start: number; avg: number }[]) {
      let list = byMetricBuckets.get(row.metric_id);
      if (!list) {
        list = [];
        byMetricBuckets.set(row.metric_id, list);
      }
      list.push({ ts: row.bucket_start * 1_000, value: row.avg });
    }

    // 候选指标 = ring 有点的 ∪ 范围内有 15min 桶的（后者覆盖重启后 ring 为空的场景）
    const metricIds = new Set<string>([...ring.keys(), ...byMetricBuckets.keys()]);

    const result: { [metric: string]: { ts: number; value: number }[] } = {};
    for (const metric of metricIds) {
      const all = ring.get(metric) ?? [];
      const ringPts = all.filter((p) => p.ts >= fromTs);
      const bucketPts = byMetricBuckets.get(metric) ?? [];

      let series: { ts: number; value: number }[];
      if (all.length > 0 && fromTs >= all[0].ts) {
        // 降源规则①：ring 覆盖请求区间 → 纯 ring（5s 细分辨率，不掺桶点）
        series = ringPts;
      } else {
        // 降源规则②：更长的历史窗口 → 桶 avg 点 + ring 点合并去重（同 ts ring 优先）
        series = mergeDedup(bucketPts, ringPts);
      }
      if (series.length > 0) result[metric] = series;
    }
    return result;
  }

  /** 两列（各自升序）合并为升序；同 ts 保留 b（ring） */
  function mergeDedup(
    a: { ts: number; value: number }[],
    b: { ts: number; value: number }[],
  ): { ts: number; value: number }[] {
    const out: { ts: number; value: number }[] = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i].ts < b[j].ts) out.push(a[i++]);
      else if (a[i].ts > b[j].ts) out.push(b[j++]);
      else {
        out.push(b[j]); // 同 ts：ring 点优先于桶聚合点
        i++;
        j++;
      }
    }
    while (i < a.length) out.push(a[i++]);
    while (j < b.length) out.push(b[j++]);
    return out;
  }

  function flushMinuteBuckets(): void {
    const nowSec = Math.floor(now() / 1_000);
    db.transaction(() => {
      for (const [metric, byMinute] of minutes) {
        for (const [minuteStartSec, acc] of byMinute) {
          // 只落盘"已完整结束"的分钟：当前进行中的半截分钟留到下次 flush，
          // 保证桶内 count/avg 覆盖整分钟（60s 调度下每桶恰在结束后第一个 tick 落盘）
          if (minuteStartSec + 60 > nowSec) continue;
          insertBucket.run(
            metric,
            1,
            minuteStartSec,
            acc.min,
            acc.max,
            acc.sum / acc.count,
            acc.count,
          );
          byMinute.delete(minuteStartSec); // 清空累加器：重复 flush 不重复写（幂等）
        }
      }
    })();
  }

  function rollup15AndPurge(): void {
    const nowSec = Math.floor(now() / 1_000);
    db.transaction(() => {
      // 1) rollup：1min 桶按 15min 窗口归并。每次全量重算保留期内的完整窗口，
      //    落盘用 INSERT OR REPLACE——同一窗口重跑产出完全相同的值（幂等不重不坏），
      //    且迟到落盘的 1min 桶能在下一轮 rollup 自愈进对应 15min 桶。
      //    未完整结束的窗口不出行（15min 桶一经写入即视为最终值）。
      const windows = new Map<string, { metric: string; start: number; min: number; max: number; sum: number; count: number }>();
      for (const row of select1minBuckets.all(nowSec - RETENTION_1MIN_SEC) as {
        metric_id: string; bucket_start: number; min: number; max: number; avg: number; count: number;
      }[]) {
        const windowStart = Math.floor(row.bucket_start / 900) * 900;
        if (windowStart + 900 > nowSec) continue; // 窗口未结束
        const key = `${row.metric_id}\u0000${windowStart}`;
        let agg = windows.get(key);
        if (!agg) {
          agg = { metric: row.metric_id, start: windowStart, min: row.min, max: row.max, sum: 0, count: 0 };
          windows.set(key, agg);
        }
        agg.min = Math.min(agg.min, row.min);
        agg.max = Math.max(agg.max, row.max);
        agg.sum += row.avg * row.count; // 加权：avg × count 还原总量和
        agg.count += row.count;
      }
      for (const agg of windows.values()) {
        insertBucket.run(agg.metric, 15, agg.start, agg.min, agg.max, agg.sum / agg.count, agg.count);
      }

      // 2) 过期清理：1min 桶 48h、15min 桶 14d（rollup 先于清理，数据先归档再淘汰）
      purge1min.run(nowSec - RETENTION_1MIN_SEC);
      purge15min.run(nowSec - RETENTION_15MIN_SEC);
    })();
  }

  function aggregateRange(
    metric: string,
    fromTs: number,
    toTs: number,
  ): { max: number; avg: number; count: number } | null {
    const bucketRows = selectBucketsForRange.all(metric, fromTs, toTs) as {
      bucket_start: number;
      max: number;
      avg: number;
      count: number;
    }[];

    // 桶路：max 直接取列最大值；avg 要按 count 加权反推总量和（同 rollup 的加权手法），
    // 不能对 avg 列本身取平均。lastBucketEnd 记住"桶覆盖到哪里"（右边界），
    // ring 路补齐桶未覆盖的两端（见下方 firstBucketStart 注释）。
    let bucketMax = -Infinity;
    let bucketSum = 0;
    let bucketCount = 0;
    let lastBucketEnd = fromTs; // 桶表在区间内无行时，整个区间都走 ring
    for (const row of bucketRows) {
      bucketMax = Math.max(bucketMax, row.max);
      bucketSum += row.avg * row.count;
      bucketCount += row.count;
      lastBucketEnd = Math.max(lastBucketEnd, row.bucket_start * 1_000 + 60_000);
    }

    // firstBucketStart：桶覆盖的左边界。SQL 用 bucket_start*1000 >= fromTs 筛选，
    // 当 fromTs 不落在分钟整点时（真实场景里 openRun 用 Date.now()，几乎不可能对齐），
    // fromTs 所在的首个不完整分钟，其桶起点早于 fromTs，会被这条 SQL 整行排除——
    // 但那一分钟里 ts >= fromTs 的样本仍属于查询区间。如果 ring 路不把这段补回来，
    // 两路就同时漏掉它：桶被 SQL 排除，ring 又被 lastBucketEnd 卡在桶覆盖区间之后。
    // 这对本任务是致命的：llama.cpp 加载大模型时显存一次性分配到位，峰值往往就落在
    // 启动后头一分钟内，恰好是首个不完整分钟——漏掉这段等于峰值测不到。
    // bucketRows 已按 bucket_start 升序，首行起点即左边界；无桶命中时取 toTs+1，
    // 条件退化为整个区间都走 ring（与「纯 ring 场景」一致）。
    const firstBucketStart = bucketRows.length > 0 ? bucketRows[0].bucket_start * 1_000 : toTs + 1;

    const ringPoints = (ring.get(metric) ?? []).filter(
      (p) => p.ts >= fromTs && p.ts <= toTs && (p.ts < firstBucketStart || p.ts >= lastBucketEnd),
    );
    let ringMax = -Infinity;
    let ringSum = 0;
    for (const p of ringPoints) {
      if (p.value > ringMax) ringMax = p.value;
      ringSum += p.value;
    }

    const count = bucketCount + ringPoints.length;
    if (count === 0) return null;

    return {
      max: Math.max(bucketMax, ringMax),
      avg: (bucketSum + ringSum) / count,
      count,
    };
  }

  // ---- 生产调度（测试手动调 flush/rollup，不走这里） ----
  let flushTimer: ReturnType<typeof setInterval> | undefined;
  let rollupTimer: ReturnType<typeof setInterval> | undefined;

  return {
    push,
    queryRange,
    flushMinuteBuckets,
    rollup15AndPurge,
    aggregateRange,

    startFlushTimers() {
      if (flushTimer !== undefined && rollupTimer !== undefined) return; // 幂等
      if (flushTimer === undefined) flushTimer = setInterval(() => flushMinuteBuckets(), 60_000);
      if (rollupTimer === undefined) rollupTimer = setInterval(() => rollup15AndPurge(), 15 * 60_000);
    },

    stopFlushTimers() {
      if (flushTimer !== undefined) {
        clearInterval(flushTimer);
        flushTimer = undefined;
      }
      if (rollupTimer !== undefined) {
        clearInterval(rollupTimer);
        rollupTimer = undefined;
      }
    },
  };
}
