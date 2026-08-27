import { describe, expect, it } from "vitest";
import { createNvidiaSmiCollector, type ExecFileLike } from "./nvidiaSmi";
import { METRIC_IDS } from "./ids";

/**
 * nvidia-smi 采集器测试（M3 Task 2 建立 / M5 多卡聚合修复补齐，TDD）
 *
 * execFile 全部 mock：ENOENT（无 NVIDIA 环境）→ 特性降级；
 * 正常 CSV 六列（index/memUsed/memTotal/util/temp/power）→ 聚合两个时序
 * 样本 + 分卡快照；坏行跳过。
 *
 * 本机是单卡 RTX 3090，多卡聚合路径无法真机验证，全靠本文件的多卡用例
 * 钉死行为——尤其是"两张卡撞进同一条时序"的回归场景。
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

/** 单卡真机实测样例行（六列改造后的标准形态），供 probe/重探/status 等
 * 不关心具体数值的用例复用 */
const SINGLE_GPU_LINE = "0, 1, 24576, 0, 33, 9.55\n";

describe("createNvidiaSmiCollector：probe 特性探测", () => {
  it("ENOENT → { available:false }，tick 无样本，isAvailable false", async () => {
    const collector = createNvidiaSmiCollector({ execFile: fakeExec([{ error: enoent() }]) });

    await expect(collector.probe()).resolves.toEqual({ available: false });
    expect(collector.isAvailable()).toBe(false);
    expect(await collector.tick()).toEqual([]);
  });

  it("成功 → { available:true }，isAvailable true", async () => {
    const collector = createNvidiaSmiCollector({ execFile: fakeExec([{ stdout: SINGLE_GPU_LINE }]) });

    await expect(collector.probe()).resolves.toEqual({ available: true });
    expect(collector.isAvailable()).toBe(true);
  });

  it("probe 查询参数：六列 --query-gpu=index,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw", async () => {
    const exec = fakeExec([{ stdout: SINGLE_GPU_LINE }]);
    const collector = createNvidiaSmiCollector({ execFile: exec });
    await collector.probe();

    expect(exec.calls[0]).toEqual([
      "nvidia-smi",
      "--query-gpu=index,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw",
      "--format=csv,noheader,nounits",
    ]);
  });
});

describe("createNvidiaSmiCollector：tick 未 probe / 执行失败", () => {
  it("未 probe（available 默认 false）→ 不执行 nvidia-smi，无样本", async () => {
    const exec = fakeExec([{ stdout: SINGLE_GPU_LINE }]);
    const collector = createNvidiaSmiCollector({ execFile: exec });

    expect(await collector.tick()).toEqual([]);
    expect(exec.calls).toEqual([]);
  });

  it("tick 执行失败（nvidia-smi 运行中消失）→ 无样本，available 翻 false（特性降级）", async () => {
    const collector = createNvidiaSmiCollector({
      execFile: fakeExec([{ stdout: SINGLE_GPU_LINE }, { error: enoent() }]),
    });
    await collector.probe();
    expect(collector.isAvailable()).toBe(true);

    expect(await collector.tick()).toEqual([]);
    expect(collector.isAvailable()).toBe(false);
  });
});

describe("createNvidiaSmiCollector：多卡聚合（M5 多卡缺陷修复）", () => {
  it("双卡回归：mem 求和、util 求平均，样本总数恒为 2（不是撞车的 4）", async () => {
    const stdout = "0, 8192, 24576, 45, 67, 320.5\n1, 6144, 24576, 78, 72, 355.0\n";
    const collector = createNvidiaSmiCollector({ execFile: fakeExec([{ stdout }]) });
    await collector.probe();

    const samples = await collector.tick();

    expect(samples).toHaveLength(2); // 不是缺陷态的 4（按行 push 撞车）
    expect(samples[0]).toEqual({ metric: METRIC_IDS.gpuMemUsedMib, value: 14336, ts: expect.any(Number) });
    expect(samples[1]).toEqual({ metric: METRIC_IDS.gpuUtilPercent, value: 61.5, ts: expect.any(Number) });

    const devices = collector.devices();
    expect(devices).toHaveLength(2);
    expect(devices[0]).toEqual({
      index: 0,
      memUsedMib: 8192,
      memTotalMib: 24576,
      utilPercent: 45,
      tempC: 67,
      powerW: 320.5,
    });
    expect(devices[1]).toEqual({
      index: 1,
      memUsedMib: 6144,
      memTotalMib: 24576,
      utilPercent: 78,
      tempC: 72,
      powerW: 355,
    });
  });

  it("无锯齿：连续两轮 tick 的 util 序列是稳定的 [61.5, 61.5]，不是缺陷态的 [45, 78, 45, 78]", async () => {
    const stdout = "0, 8192, 24576, 45, 67, 320.5\n1, 6144, 24576, 78, 72, 355.0\n";
    const collector = createNvidiaSmiCollector({ execFile: fakeExec([{ stdout }]) });
    await collector.probe();

    const utilSeries: number[] = [];
    for (let i = 0; i < 2; i++) {
      const samples = await collector.tick();
      const util = samples.find((s) => s.metric === METRIC_IDS.gpuUtilPercent);
      utilSeries.push(util!.value);
    }

    expect(utilSeries).toEqual([61.5, 61.5]);
  });

  it("单卡等价性：单卡输入下 sum/avg 退化为该卡自身值，与聚合前的原始单卡值逐字段相同", async () => {
    const stdout = "0, 8192, 24576, 45, 67, 320.5\n";
    const collector = createNvidiaSmiCollector({ execFile: fakeExec([{ stdout }]) });
    await collector.probe();

    const samples = await collector.tick();

    expect(samples).toEqual([
      { metric: METRIC_IDS.gpuMemUsedMib, value: 8192, ts: expect.any(Number) },
      { metric: METRIC_IDS.gpuUtilPercent, value: 45, ts: expect.any(Number) },
    ]);
  });

  it("三卡：sum/avg 在 N>2 时依然正确", async () => {
    const stdout =
      "0, 2000, 24576, 10, 60, 100\n" + "1, 3000, 24576, 20, 65, 150\n" + "2, 5000, 24576, 30, 70, 200\n";
    const collector = createNvidiaSmiCollector({ execFile: fakeExec([{ stdout }]) });
    await collector.probe();

    const samples = await collector.tick();

    expect(samples[0]).toEqual({ metric: METRIC_IDS.gpuMemUsedMib, value: 10000, ts: expect.any(Number) });
    expect(samples[1]).toEqual({ metric: METRIC_IDS.gpuUtilPercent, value: 20, ts: expect.any(Number) });
    expect(collector.devices()).toHaveLength(3);
  });

  it("温度/功耗为 N/A → 该字段 null，且该行仍计入 mem/util 聚合", async () => {
    const stdout = "0, 8192, 24576, 45, N/A, N/A\n";
    const collector = createNvidiaSmiCollector({ execFile: fakeExec([{ stdout }]) });
    await collector.probe();

    const samples = await collector.tick();

    expect(samples).toEqual([
      { metric: METRIC_IDS.gpuMemUsedMib, value: 8192, ts: expect.any(Number) },
      { metric: METRIC_IDS.gpuUtilPercent, value: 45, ts: expect.any(Number) },
    ]);
    expect(collector.devices()[0]).toMatchObject({ tempC: null, powerW: null });
  });

  it("坏行混杂（合法行 + 空行 + 缺列行 + 必需列 N/A 行）→ 只有合法行参与聚合", async () => {
    const stdout =
      "0, 8192, 24576, 45, 67, 320.5\n" + // 合法
      "\n" + // 空行（nvidia-smi 真实输出尾部天然带一个）
      "1, 6000\n" + // 缺列（必需 4 列不全）
      "2, N/A, 24576, 50, 60, 100\n"; // 必需列（memUsed）N/A
    const collector = createNvidiaSmiCollector({ execFile: fakeExec([{ stdout }]) });
    await collector.probe();

    const samples = await collector.tick();

    expect(samples).toEqual([
      { metric: METRIC_IDS.gpuMemUsedMib, value: 8192, ts: expect.any(Number) },
      { metric: METRIC_IDS.gpuUtilPercent, value: 45, ts: expect.any(Number) },
    ]);
    expect(collector.devices()).toHaveLength(1);
  });

  it("全坏行 / 空 stdout → tick 返回 []，devices() 保留上一次成功的值", async () => {
    const goodStdout = "0, 8192, 24576, 45, 67, 320.5\n";
    const collector = createNvidiaSmiCollector({
      // 下标 0 给 probe() 消费，下标 1 起才是各次 tick() 的返回值
      execFile: fakeExec([
        { stdout: goodStdout },
        { stdout: goodStdout },
        { stdout: "0, N/A, 24576, 50, 40, 100\n" },
        { stdout: "" },
      ]),
    });
    await collector.probe();

    await collector.tick(); // 建立一次成功快照
    const snapshotAfterSuccess = collector.devices();
    expect(snapshotAfterSuccess).toHaveLength(1);

    expect(await collector.tick()).toEqual([]); // 全坏行
    expect(collector.devices()).toEqual(snapshotAfterSuccess); // 未被清空

    expect(await collector.tick()).toEqual([]); // 空 stdout
    expect(collector.devices()).toEqual(snapshotAfterSuccess); // 依旧保留
  });

  it("devices() 在从未成功采集时返回 []", async () => {
    const collector = createNvidiaSmiCollector({ execFile: fakeExec([{ error: enoent() }]) });

    expect(collector.devices()).toEqual([]);
    await collector.probe();
    expect(collector.devices()).toEqual([]);
  });
});

describe("createNvidiaSmiCollector：重探节流（M4 真机回归 #8）", () => {
  it("运行中失败后能自愈：到重探间隔时 tick 重新探测，产出样本且 isAvailable 回 true", async () => {
    let currentTime = 0;
    const exec = fakeExec([
      { stdout: SINGLE_GPU_LINE }, // probe 成功
      { error: enoent() }, // 运行中失败 → 降级
      { stdout: SINGLE_GPU_LINE }, // 到重探间隔后恢复
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
    const exec = fakeExec([{ stdout: SINGLE_GPU_LINE }, { error: enoent() }]);
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
      { stdout: SINGLE_GPU_LINE }, // probe 成功
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
      { stdout: SINGLE_GPU_LINE }, // 到点重探成功
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

describe("createNvidiaSmiCollector：三态 status（M5 Task 4）", () => {
  it("probe 前状态为 probing（区别于探测确认的 unavailable）", () => {
    const collector = createNvidiaSmiCollector({ execFile: fakeExec([]) });
    expect(collector.status()).toBe("probing");
    expect(collector.isAvailable()).toBe(false); // 旧接口语义不变
  });

  it("probe 成功 → available；失败 → unavailable（不再是 probing）", async () => {
    const ok = createNvidiaSmiCollector({ execFile: fakeExec([{ stdout: SINGLE_GPU_LINE }]) });
    await ok.probe();
    expect(ok.status()).toBe("available");

    const bad = createNvidiaSmiCollector({ execFile: fakeExec([{ error: enoent() }]) });
    await bad.probe();
    expect(bad.status()).toBe("unavailable");
  });

  it("probe 失败后推进到重探间隔，tick 成功自愈 → status 变为 available", async () => {
    let currentTime = 0;
    const exec = fakeExec([
      { error: enoent() }, // probe 失败
      { stdout: SINGLE_GPU_LINE }, // 到点重探成功
    ]);
    const collector = createNvidiaSmiCollector({ execFile: exec, now: () => currentTime });

    await collector.probe();
    expect(collector.status()).toBe("unavailable");

    currentTime += 60_000;
    await collector.tick();
    expect(collector.status()).toBe("available");
  });

  it("从未 probe 直接 tick（恒空转分支）→ status 仍为 probing", async () => {
    const exec = fakeExec([{ stdout: SINGLE_GPU_LINE }]);
    const collector = createNvidiaSmiCollector({ execFile: exec });

    expect(await collector.tick()).toEqual([]);
    expect(collector.status()).toBe("probing");
    expect(exec.calls).toEqual([]); // 未 probe 过，tick 不应起子进程
  });
});
