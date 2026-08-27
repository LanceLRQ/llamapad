import type Database from "better-sqlite3";

/**
 * 运行历史仓储（U17 T1，milestones/11 §2.1）
 *
 * 每次模型启动/结束记一行（migration v7 的 runs 表）。峰值显存存两个原始
 * 读数（peak_gpu_mem_mib / baseline_gpu_mem_mib）而非直接存差值——整卡
 * 显存会被同机其它进程占用抬高，存原始值保留日后改口径重算历史的余地；
 * `peakNetMibFor` 对外只暴露算好的净增量（峰值-基线）。
 *
 * closeRun 的幂等靠 SQL 自身保证：UPDATE 语句带 `ended_at IS NULL` 守卫，
 * id 不存在或该行已结束时天然影响 0 行，不需要额外查询判断，也不会有
 * 先查后写的竞态窗口。
 *
 * judgePreflight 是与仓储解耦的纯函数（设计 §2.1 明确要求），只依赖两个
 * 数值即可单测，不必为了测三态判定去起内存库。
 */

export interface RunRecord {
  id: number;
  model: string;
  started_at: number;
  ended_at: number | null;
  end_reason: string | null;
  avg_tokens_per_sec: number | null;
  peak_tokens_per_sec: number | null;
  peak_gpu_mem_mib: number | null;
  baseline_gpu_mem_mib: number | null;
  gpu_mem_total_mib: number | null;
}

/** 结束时回填的聚合值（来自 metrics store 的区间聚合） */
export interface RunAggregates {
  avgTokensPerSec: number | null;
  peakTokensPerSec: number | null;
  peakGpuMemMib: number | null;
}

export interface RunsRepo {
  /** 开启一次运行，started_at 取 now()，返回自增 id */
  openRun(model: string, baselineMib: number | null, totalMib: number | null): number;
  /** 结束一次运行并回填聚合；id 不存在或已结束则静默忽略（幂等，见文件头注释） */
  closeRun(id: number, reason: string, agg: RunAggregates): void;
  /** 当前悬空（未结束）的 run；正常至多一行，多条时取 started_at 最大的；无则 null */
  getOpenRun(): RunRecord | null;
  /** 倒序（按 started_at）列出最近的 run */
  listRuns(limit: number): RunRecord[];
  /** 该模型历史净增量显存峰值 max(peak - baseline)；只统计两列都非 NULL 的行；无有效样本 → null */
  peakNetMibFor(model: string): number | null;
  /** 该模型参与 preflight 统计的历史 run 数；筛选条件须与 peakNetMibFor 完全一致，否则 UI 展示的次数与峰值来源对不上 */
  countRunsFor(model: string): number;
}

export function createRunsRepo(
  db: Database.Database,
  opts?: { now?: () => number },
): RunsRepo {
  const now = opts?.now ?? Date.now;

  const insertRun = db.prepare(
    "INSERT INTO runs(model, started_at, baseline_gpu_mem_mib, gpu_mem_total_mib) VALUES (?, ?, ?, ?)",
  );
  const closeRunStmt = db.prepare(`
    UPDATE runs
    SET ended_at = ?, end_reason = ?, avg_tokens_per_sec = ?, peak_tokens_per_sec = ?, peak_gpu_mem_mib = ?
    WHERE id = ? AND ended_at IS NULL
  `);
  const getOpenRunStmt = db.prepare(
    "SELECT * FROM runs WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
  );
  const listRunsStmt = db.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?");
  const peakNetMibForStmt = db.prepare(`
    SELECT MAX(peak_gpu_mem_mib - baseline_gpu_mem_mib) AS peak_net
    FROM runs
    WHERE model = ? AND peak_gpu_mem_mib IS NOT NULL AND baseline_gpu_mem_mib IS NOT NULL
  `);
  // 筛选条件与 peakNetMibForStmt 逐字一致（同一份 WHERE）——两者口径必须对齐，
  // 否则 UI 会出现「基于 N 次运行」但峰值其实只由更少行算出的误导展示。
  const countRunsForStmt = db.prepare(`
    SELECT COUNT(*) AS n
    FROM runs
    WHERE model = ? AND peak_gpu_mem_mib IS NOT NULL AND baseline_gpu_mem_mib IS NOT NULL
  `);

  return {
    openRun(model, baselineMib, totalMib) {
      const result = insertRun.run(model, now(), baselineMib, totalMib);
      return Number(result.lastInsertRowid);
    },

    closeRun(id, reason, agg) {
      closeRunStmt.run(now(), reason, agg.avgTokensPerSec, agg.peakTokensPerSec, agg.peakGpuMemMib, id);
    },

    getOpenRun() {
      return (getOpenRunStmt.get() as RunRecord | undefined) ?? null;
    },

    listRuns(limit) {
      return listRunsStmt.all(limit) as RunRecord[];
    },

    peakNetMibFor(model) {
      const row = peakNetMibForStmt.get(model) as { peak_net: number | null } | undefined;
      return row?.peak_net ?? null;
    },

    countRunsFor(model) {
      const row = countRunsForStmt.get(model) as { n: number };
      return row.n;
    },
  };
}

/** preflight 判定结果：unknown 表示数据不足以判断（GPU 不可用或该模型无历史） */
export type PreflightVerdict = "ok" | "warn" | "unknown";

/** preflight 判定（纯函数，与仓储解耦便于单测，见文件头注释） */
export function judgePreflight(freeMib: number | null, peakNetMib: number | null): PreflightVerdict {
  if (freeMib === null || peakNetMib === null) return "unknown";
  return freeMib < peakNetMib ? "warn" : "ok";
}
