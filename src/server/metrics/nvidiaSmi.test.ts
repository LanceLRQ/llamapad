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

describe("createNvidiaSmiCollector：重探节流（M4 真机回归 #8）", () => {
  it("运行中失败后能自愈：到重探间隔时 tick 重新探测，产出样本且 isAvailable 回 true", async () => {
    let currentTime = 0;
    const exec = fakeExec([
      { stdout: "24576, 37\n" }, // probe 成功
      { error: enoent() }, // 运行中失败 → 降级
      { stdout: "24576, 37\n" }, // 到重探间隔后恢复
    ]);
    const collector = createNvidiaSmiCollector({ execFile: exec, now: () => currentTime });

    await collector.probe();
    expect(collector.isAvailable()).toBe(true);

    expect(await collector.tick()).toEqual([]); // 运行中失败 → 降级
    expect(collector.isAvailable()).toBe(false);

    currentTime += 60_000; // 推进到重探间隔
    const samples = await collector.tick();
    expect(collector.isAvailable()).toBe(true); // 重探成功 → 自愈
    expect(samples).toHaveLength(2);
    expect(exec.calls).toHaveLength(3);
  });

  it("未到重探间隔时 tick 不起子进程（节流保证）", async () => {
    let currentTime = 0;
    const exec = fakeExec([{ stdout: "24576, 37\n" }, { error: enoent() }]);
    const collector = createNvidiaSmiCollector({ execFile: exec, now: () => currentTime });

    await collector.probe();
    await collector.tick(); // 运行中失败 → 降级，lastFailureAt = 0
    expect(exec.calls).toHaveLength(2);

    currentTime += 59_999; // 差 1ms 未到 60s
    expect(await collector.tick()).toEqual([]);
    expect(exec.calls).toHaveLength(2); // 没有新增子进程调用
  });

  it("到点重探仍失败 → 保持不可用，计时窗口从本次失败重新起算", async () => {
    let currentTime = 0;
    const exec = fakeExec([
      { stdout: "24576, 37\n" }, // probe 成功
      { error: enoent() }, // 运行中失败 t=0
      { error: enoent() }, // 到点重探仍失败 t=60000
    ]);
    const collector = createNvidiaSmiCollector({ execFile: exec, now: () => currentTime });

    await collector.probe();
    await collector.tick(); // lastFailureAt = 0

    currentTime = 60_000;
    expect(await collector.tick()).toEqual([]); // 到点重探，仍失败 → lastFailureAt 刷新为 60000
    expect(collector.isAvailable()).toBe(false);
    expect(exec.calls).toHaveLength(3);

    currentTime = 60_000 + 59_999; // 从新的失败点起算，未到 60s
    expect(await collector.tick()).toEqual([]);
    expect(exec.calls).toHaveLength(3); // 没有新增调用，证明计时窗口已重新起算
  });

  it("probe 失败后到点重探成功 → 翻 true 并产出样本（驱动晚于面板就绪场景）", async () => {
    let currentTime = 0;
    const exec = fakeExec([
      { error: enoent() }, // probe 失败（驱动未就绪）
      { stdout: "24576, 37\n" }, // 到点重探成功
    ]);
    const collector = createNvidiaSmiCollector({ execFile: exec, now: () => currentTime });

    await expect(collector.probe()).resolves.toEqual({ available: false });
    expect(collector.isAvailable()).toBe(false);

    currentTime += 60_000;
    const samples = await collector.tick();
    expect(collector.isAvailable()).toBe(true);
    expect(samples).toHaveLength(2);
  });
});
