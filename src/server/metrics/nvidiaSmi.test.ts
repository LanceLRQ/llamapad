import { describe, expect, it } from "vitest";
import { createNvidiaSmiCollector, type ExecFileLike } from "./nvidiaSmi";
import { METRIC_IDS } from "./ids";

/**
 * nvidia-smi 采集器测试（M3 Task 2，TDD）
 *
 * execFile 全部 mock：ENOENT（无 NVIDIA 环境）→ 特性降级；
 * 正常 CSV → 每行两个样本；坏行跳过。
 */

/** ENOENT 风格错误（nvidia-smi 不存在时 child_process 的报错形态） */
function enoent(): Error {
  const err = new Error("spawn nvidia-smi ENOENT") as Error & { code: string };
  err.code = "ENOENT";
  return err;
}

/** 按序返回预设结果的 execFile mock（结果耗尽后重复最后一个） */
function fakeExec(
  results: Array<{ stdout?: string; error?: Error | null }>,
): ExecFileLike & { calls: string[][] } {
  const calls: string[][] = [];
  let n = 0;
  const fn: ExecFileLike & { calls: string[][] } = (command, args, callback) => {
    calls.push([command, ...args]);
    const result = results[Math.min(n++, results.length - 1)] ?? { stdout: "" };
    callback(result.error ?? null, result.stdout ?? "");
    return undefined as never;
  };
  fn.calls = calls;
  return fn;
}

describe("createNvidiaSmiCollector：probe 特性探测", () => {
  it("ENOENT → { available:false }，tick 无样本，isAvailable false", async () => {
    const collector = createNvidiaSmiCollector({ execFile: fakeExec([{ error: enoent() }]) });

    await expect(collector.probe()).resolves.toEqual({ available: false });
    expect(collector.isAvailable()).toBe(false);
    expect(await collector.tick()).toEqual([]);
  });

  it("成功 → { available:true }，isAvailable true", async () => {
    const collector = createNvidiaSmiCollector({ execFile: fakeExec([{ stdout: "24576, 37\n" }]) });

    await expect(collector.probe()).resolves.toEqual({ available: true });
    expect(collector.isAvailable()).toBe(true);
  });

  it("probe 查询参数：--query-gpu=memory.used,utilization.gpu --format=csv,noheader,nounits", async () => {
    const exec = fakeExec([{ stdout: "24576, 37\n" }]);
    const collector = createNvidiaSmiCollector({ execFile: exec });
    await collector.probe();

    expect(exec.calls[0]).toEqual([
      "nvidia-smi",
      "--query-gpu=memory.used,utilization.gpu",
      "--format=csv,noheader,nounits",
    ]);
  });
});

describe("createNvidiaSmiCollector：tick CSV 解析", () => {
  it("未 probe（available 默认 false）→ 不执行 nvidia-smi，无样本", async () => {
    const exec = fakeExec([{ stdout: "24576, 37\n" }]);
    const collector = createNvidiaSmiCollector({ execFile: exec });

    expect(await collector.tick()).toEqual([]);
    expect(exec.calls).toEqual([]);
  });

  it("正常 CSV 两 GPU 两行 → 每行 mem_used_mib + util_percent 两个样本（共 4 个）", async () => {
    const collector = createNvidiaSmiCollector({ execFile: fakeExec([{ stdout: "24576, 37\n1024, 0\n" }]) });
    await collector.probe();

    const samples = await collector.tick();

    expect(samples.map((s) => s.metric)).toEqual([
      METRIC_IDS.gpuMemUsedMib,
      METRIC_IDS.gpuUtilPercent,
      METRIC_IDS.gpuMemUsedMib,
      METRIC_IDS.gpuUtilPercent,
    ]);
    expect(samples.map((s) => s.value)).toEqual([24576, 37, 1024, 0]);
    expect(samples.every((s) => s.ts > 0)).toBe(true);
    expect(METRIC_IDS.gpuMemUsedMib).toBe("gpu.mem_used_mib");
    expect(METRIC_IDS.gpuUtilPercent).toBe("gpu.util_percent");
  });

  it("坏行跳过（N/A / 空行 / 缺列），数值行照常产出", async () => {
    const collector = createNvidiaSmiCollector({ execFile: fakeExec([{ stdout: "N/A, 5\n\n24576, 37\n" }]) });
    await collector.probe();

    const samples = await collector.tick();

    expect(samples).toHaveLength(2); // 只剩 "24576, 37" 一行
    expect(samples[0]).toEqual({ metric: METRIC_IDS.gpuMemUsedMib, value: 24576, ts: expect.any(Number) });
    expect(samples[1]).toEqual({ metric: METRIC_IDS.gpuUtilPercent, value: 37, ts: expect.any(Number) });
  });

  it("tick 执行失败（nvidia-smi 运行中消失）→ 无样本，available 翻 false（特性降级）", async () => {
    const collector = createNvidiaSmiCollector({
      execFile: fakeExec([{ stdout: "24576, 37\n" }, { error: enoent() }]),
    });
    await collector.probe();
    expect(collector.isAvailable()).toBe(true);

    expect(await collector.tick()).toEqual([]);
    expect(collector.isAvailable()).toBe(false);
  });
});
