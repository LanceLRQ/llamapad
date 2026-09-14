import { describe, expect, it } from "vitest";

import { createFakeGpuExecFile } from "./fake-gpus";
import { parseGpuCsvLines } from "./nvidiaSmi";

/** 把 ExecFileLike 的回调形态包成 Promise，方便测试里 await 取 stdout */
function runOnce(exec: ReturnType<typeof createFakeGpuExecFile>): Promise<string> {
  return new Promise((resolve) => {
    exec("nvidia-smi", ["--query-gpu=index,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw,name"], (_error, stdout) =>
      resolve(stdout),
    );
  });
}

describe("createFakeGpuExecFile（dev-only 假多卡数据源，任务 B）", () => {
  it("产出行数等于 count", async () => {
    const stdout = await runOnce(createFakeGpuExecFile(4));
    const lines = stdout.split("\n").filter((line) => line.trim() !== "");
    expect(lines).toHaveLength(4);
  });

  it("产出能被 parseGpuCsvLines 正确解析出 count 张卡（列格式与真实采集一致）", async () => {
    const stdout = await runOnce(createFakeGpuExecFile(4));
    const devices = parseGpuCsvLines(stdout);

    expect(devices).toHaveLength(4);
    expect(devices.map((d) => d.index)).toEqual([0, 1, 2, 3]);
    // 偶数卡 V100 / 奇数卡 A100，型号与显存总量按下标奇偶交替
    expect(devices[0]).toMatchObject({ name: "Tesla V100-SXM2-32GB", memTotalMib: 32510 });
    expect(devices[1]).toMatchObject({ name: "NVIDIA A100-SXM4-80GB", memTotalMib: 81920 });
    expect(devices[2]).toMatchObject({ name: "Tesla V100-SXM2-32GB", memTotalMib: 32510 });
    expect(devices[3]).toMatchObject({ name: "NVIDIA A100-SXM4-80GB", memTotalMib: 81920 });
    // 每张卡都应有完整字段（结构完整，不是被当坏行漏解析）
    for (const device of devices) {
      expect(device.tempC).not.toBeNull();
      expect(device.powerW).not.toBeNull();
      expect(device.memUsedMib).toBeGreaterThanOrEqual(0);
      expect(device.memUsedMib).toBeLessThanOrEqual(device.memTotalMib);
    }
  });

  it("count 为 0 → 产出空 CSV，解析出 0 张卡", async () => {
    const stdout = await runOnce(createFakeGpuExecFile(0));
    expect(stdout).toBe("");
    expect(parseGpuCsvLines(stdout)).toEqual([]);
  });

  it("count 为负数 → 视同 0，不抛异常", async () => {
    const stdout = await runOnce(createFakeGpuExecFile(-3));
    expect(stdout).toBe("");
    expect(parseGpuCsvLines(stdout)).toEqual([]);
  });

  it("count 为非整数（小数）→ 视同 0，不抛异常", async () => {
    const stdout = await runOnce(createFakeGpuExecFile(2.5));
    expect(stdout).toBe("");
    expect(parseGpuCsvLines(stdout)).toEqual([]);
  });

  it("连续调用：结构（张数/index/型号）不变，数值随内部计数器小幅摆动", async () => {
    const exec = createFakeGpuExecFile(2);
    const first = parseGpuCsvLines(await runOnce(exec));
    const second = parseGpuCsvLines(await runOnce(exec));
    const third = parseGpuCsvLines(await runOnce(exec));

    for (const devices of [first, second, third]) {
      expect(devices).toHaveLength(2);
      expect(devices.map((d) => d.index)).toEqual([0, 1]);
      expect(devices.map((d) => d.name)).toEqual(["Tesla V100-SXM2-32GB", "NVIDIA A100-SXM4-80GB"]);
    }

    // 数值不是每次调用都原样重复——三次调用间至少出现一次变化
    const memSeriesDevice0 = [first[0]!.memUsedMib, second[0]!.memUsedMib, third[0]!.memUsedMib];
    expect(new Set(memSeriesDevice0).size).toBeGreaterThan(1);
  });

  it("多个实例各自持有独立计数器，不共享全局状态", async () => {
    const execA = createFakeGpuExecFile(1);
    await runOnce(execA);
    await runOnce(execA); // execA 已经推进了两拍

    const execB = createFakeGpuExecFile(1); // 全新实例，计数器从头开始
    const bFirst = parseGpuCsvLines(await runOnce(execB));

    const execC = createFakeGpuExecFile(1); // 另一个全新实例，同样从头开始
    const cFirst = parseGpuCsvLines(await runOnce(execC));

    // execB / execC 互不受 execA 已调用次数的影响：首帧数值应当一致
    expect(bFirst[0]!.memUsedMib).toBe(cFirst[0]!.memUsedMib);
  });
});
