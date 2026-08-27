import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb, runMigrations } from "./db";
import { createRunsRepo, judgePreflight, type RunsRepo } from "./runs";

/**
 * 运行历史仓储测试（U17 T1，TDD）
 *
 * 时间走注入的 now（毫秒）。两处核心正确性断言：
 * - closeRun 的幂等性——UPDATE 语句自带 `ended_at IS NULL` 守卫，id 不存在
 *   或已结束时天然影响 0 行，无需额外查询判断
 * - peakNetMibFor 只统计 baseline/peak 都非 NULL 的行（GPU 不可用的 run
 *   不参与统计，见 migration v7 注释）
 */

const T0 = new Date("2026-01-01T00:00:00Z").getTime();

let db: Database.Database;
let clock: number;
let repo: RunsRepo;

beforeEach(() => {
  db = openDb(":memory:");
  runMigrations(db);
  clock = T0;
  repo = createRunsRepo(db, { now: () => clock });
});

afterEach(() => {
  db.close();
});

describe("openRun / getOpenRun", () => {
  it("openRun 写入一行并返回 id，getOpenRun 能取到该行", () => {
    const id = repo.openRun("m1", 1000, 24000);
    const open = repo.getOpenRun();
    expect(open).toEqual({
      id,
      model: "m1",
      started_at: T0,
      ended_at: null,
      end_reason: null,
      avg_tokens_per_sec: null,
      peak_tokens_per_sec: null,
      peak_gpu_mem_mib: null,
      baseline_gpu_mem_mib: 1000,
      gpu_mem_total_mib: 24000,
    });
  });

  it("多条悬空行时取 started_at 最大的一条", () => {
    repo.openRun("m1", 1000, 24000);
    clock = T0 + 10_000;
    const laterId = repo.openRun("m2", 2000, 24000);

    const open = repo.getOpenRun();
    expect(open?.id).toBe(laterId);
    expect(open?.model).toBe("m2");
  });

  it("无悬空行时返回 null", () => {
    expect(repo.getOpenRun()).toBeNull();
  });
});

describe("closeRun", () => {
  it("回填 ended_at / end_reason / 三项聚合值，之后 getOpenRun 返回 null", () => {
    const id = repo.openRun("m1", 1000, 24000);
    clock = T0 + 60_000;
    repo.closeRun(id, "stopped", {
      avgTokensPerSec: 12.5,
      peakTokensPerSec: 20,
      peakGpuMemMib: 21000,
    });

    expect(repo.getOpenRun()).toBeNull();
    const [row] = repo.listRuns(1);
    expect(row).toEqual({
      id,
      model: "m1",
      started_at: T0,
      ended_at: T0 + 60_000,
      end_reason: "stopped",
      avg_tokens_per_sec: 12.5,
      peak_tokens_per_sec: 20,
      peak_gpu_mem_mib: 21000,
      baseline_gpu_mem_mib: 1000,
      gpu_mem_total_mib: 24000,
    });
  });

  it("幂等：对已结束的 run 再调一次不覆盖首次的结束时间与聚合值", () => {
    const id = repo.openRun("m1", 1000, 24000);
    clock = T0 + 60_000;
    repo.closeRun(id, "stopped", {
      avgTokensPerSec: 12.5,
      peakTokensPerSec: 20,
      peakGpuMemMib: 21000,
    });

    clock = T0 + 120_000;
    repo.closeRun(id, "switched", {
      avgTokensPerSec: 99,
      peakTokensPerSec: 99,
      peakGpuMemMib: 99,
    });

    const [row] = repo.listRuns(1);
    expect(row.ended_at).toBe(T0 + 60_000);
    expect(row.end_reason).toBe("stopped");
    expect(row.avg_tokens_per_sec).toBe(12.5);
    expect(row.peak_tokens_per_sec).toBe(20);
    expect(row.peak_gpu_mem_mib).toBe(21000);
  });

  it("对不存在的 id 静默忽略，不抛错", () => {
    expect(() =>
      repo.closeRun(9_999, "stopped", {
        avgTokensPerSec: null,
        peakTokensPerSec: null,
        peakGpuMemMib: null,
      }),
    ).not.toThrow();
  });
});

describe("listRuns", () => {
  it("按 started_at 倒序并尊重 limit", () => {
    repo.openRun("m1", 1000, 24000);
    clock = T0 + 10_000;
    repo.openRun("m2", 1000, 24000);
    clock = T0 + 20_000;
    repo.openRun("m3", 1000, 24000);

    const rows = repo.listRuns(2);
    expect(rows.map((r) => r.model)).toEqual(["m3", "m2"]);
  });
});

describe("peakNetMibFor", () => {
  it("取净增量最大值", () => {
    const id1 = repo.openRun("m1", 1, 24000);
    repo.closeRun(id1, "stopped", {
      avgTokensPerSec: null,
      peakTokensPerSec: null,
      peakGpuMemMib: 21500,
    });
    clock = T0 + 10_000;
    const id2 = repo.openRun("m1", 9000, 24000);
    repo.closeRun(id2, "stopped", {
      avgTokensPerSec: null,
      peakTokensPerSec: null,
      peakGpuMemMib: 30000,
    });

    // 21500-1=21499 vs 30000-9000=21000，取较大者
    expect(repo.peakNetMibFor("m1")).toBe(21499);
  });

  it("跳过 baseline 或 peak 为 NULL 的行（GPU 不可用的 run 不污染统计）", () => {
    const id1 = repo.openRun("m1", null, null);
    repo.closeRun(id1, "stopped", {
      avgTokensPerSec: 5,
      peakTokensPerSec: 5,
      peakGpuMemMib: null,
    });
    clock = T0 + 10_000;
    const id2 = repo.openRun("m1", 1000, 24000);
    repo.closeRun(id2, "stopped", {
      avgTokensPerSec: null,
      peakTokensPerSec: null,
      peakGpuMemMib: 5000,
    });

    expect(repo.peakNetMibFor("m1")).toBe(4000);
  });

  it("无有效行时返回 null", () => {
    expect(repo.peakNetMibFor("unknown-model")).toBeNull();
  });
});

describe("countRunsFor", () => {
  it("只数 baseline 与 peak 两列都非 NULL 的行", () => {
    const id1 = repo.openRun("m1", 1000, 24000);
    repo.closeRun(id1, "stopped", {
      avgTokensPerSec: null,
      peakTokensPerSec: null,
      peakGpuMemMib: 21000,
    });
    clock = T0 + 10_000;
    const id2 = repo.openRun("m1", 2000, 24000);
    repo.closeRun(id2, "stopped", {
      avgTokensPerSec: null,
      peakTokensPerSec: null,
      peakGpuMemMib: 22000,
    });
    clock = T0 + 20_000;
    // baseline 为 NULL（GPU 不可用时启动）—不应计入
    const id3 = repo.openRun("m1", null, null);
    repo.closeRun(id3, "stopped", {
      avgTokensPerSec: 5,
      peakTokensPerSec: 5,
      peakGpuMemMib: null,
    });

    expect(repo.countRunsFor("m1")).toBe(2);
  });

  it("无匹配行时返回 0", () => {
    expect(repo.countRunsFor("unknown-model")).toBe(0);
  });

  it("与 peakNetMibFor 口径一致：数出来的条数正是参与峰值计算的那些行", () => {
    const id1 = repo.openRun("m1", 1, 24000);
    repo.closeRun(id1, "stopped", {
      avgTokensPerSec: null,
      peakTokensPerSec: null,
      peakGpuMemMib: 21500,
    });
    clock = T0 + 10_000;
    const id2 = repo.openRun("m1", 9000, 24000);
    repo.closeRun(id2, "stopped", {
      avgTokensPerSec: null,
      peakTokensPerSec: null,
      peakGpuMemMib: 30000,
    });
    clock = T0 + 20_000;
    // baseline 为 NULL 的一行——参与 listRuns 但不参与 preflight 统计
    const id3 = repo.openRun("m1", null, null);
    repo.closeRun(id3, "stopped", {
      avgTokensPerSec: 8,
      peakTokensPerSec: 8,
      peakGpuMemMib: null,
    });

    // 口径一致断言：3 条 run 里只有 2 条参与净增量峰值计算，countRunsFor 须同为 2
    expect(repo.peakNetMibFor("m1")).toBe(21499);
    expect(repo.countRunsFor("m1")).toBe(2);
  });
});

describe("judgePreflight", () => {
  it("任一入参为 null → unknown", () => {
    expect(judgePreflight(null, 100)).toBe("unknown");
    expect(judgePreflight(100, null)).toBe("unknown");
    expect(judgePreflight(null, null)).toBe("unknown");
  });

  it("free < peak → warn", () => {
    expect(judgePreflight(99, 100)).toBe("warn");
  });

  it("free === peak → ok（边界相等不算 warn）", () => {
    expect(judgePreflight(100, 100)).toBe("ok");
  });

  it("free > peak → ok", () => {
    expect(judgePreflight(200, 100)).toBe("ok");
  });
});
