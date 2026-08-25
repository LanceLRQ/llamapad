import { describe, expect, it } from "vitest";
import type { ContainerStatsSample, DockerAdapter } from "../adapters/types";
import { createDockerStatsCollector } from "./dockerStats";
import { METRIC_IDS } from "./ids";

/**
 * docker stats 采集器测试（M3 Task 2，TDD）
 *
 * 适配层用注入的 fake（stats 返回构造好的 ContainerStatsSample），
 * 采集器只负责"运行判定 → 单帧 → 样本序列"的组装逻辑。
 */

/** 构造一帧 stats（数值取辨识度高的字面量） */
function frame(over: Partial<ContainerStatsSample> = {}): ContainerStatsSample {
  return {
    cpuPercent: 42.5,
    memBytes: 512 * 1024 * 1024,
    memLimitBytes: 1024 * 1024 * 1024,
    netRxBytes: 111,
    netTxBytes: 222,
    ts: 1_700_000_000_000,
    ...over,
  };
}

/** fake 适配层：stats 按 name 返回预设帧（缺省 "llama-server"） */
function fakeAdapter(sample: ContainerStatsSample | null): Pick<DockerAdapter, "stats"> & {
  queried: string[];
} {
  return {
    queried: [],
    async stats(name) {
      this.queried.push(name);
      return sample;
    },
  } as Pick<DockerAdapter, "stats"> & { queried: string[] };
}

describe("createDockerStatsCollector", () => {
  it("运行中 → stats() 单帧产出 cpu_percent / mem_bytes / mem_percent 三样本，mem_percent = mem/limit×100", async () => {
    const adapter = fakeAdapter(frame());
    const collector = createDockerStatsCollector(adapter, async () => ({ name: "llama-server" }));

    const samples = await collector.tick();

    expect(adapter.queried).toEqual(["llama-server"]); // 用运行容器的名字查询
    expect(samples).toHaveLength(3);
    expect(samples[0]).toEqual({ metric: METRIC_IDS.containerCpuPercent, value: 42.5, ts: frame().ts });
    expect(samples[1]).toEqual({
      metric: METRIC_IDS.containerMemBytes,
      value: 512 * 1024 * 1024,
      ts: frame().ts,
    });
    expect(samples[2]).toEqual({ metric: METRIC_IDS.containerMemPercent, value: 50, ts: frame().ts });
    // 样本 metric 与 METRIC_IDS 常量的字面量锚定（防常量与文档漂移）
    expect(METRIC_IDS.containerCpuPercent).toBe("container.cpu_percent");
    expect(METRIC_IDS.containerMemBytes).toBe("container.mem_bytes");
    expect(METRIC_IDS.containerMemPercent).toBe("container.mem_percent");
  });

  it("无运行容器（getRunning → null）→ 不查 stats，无样本", async () => {
    const adapter = fakeAdapter(frame());
    const collector = createDockerStatsCollector(adapter, async () => null);

    expect(await collector.tick()).toEqual([]);
    expect(adapter.queried).toEqual([]);
  });

  it("stats 返回 null（容器消失/未运行）→ 无样本", async () => {
    const collector = createDockerStatsCollector(fakeAdapter(null), async () => ({ name: "gone" }));
    expect(await collector.tick()).toEqual([]);
  });

  it("mem_limit 为 0 → mem_percent 0（除零守卫）", async () => {
    const collector = createDockerStatsCollector(
      fakeAdapter(frame({ memLimitBytes: 0, memBytes: 100 })),
      async () => ({ name: "llama-server" }),
    );
    const samples = await collector.tick();
    expect(samples.find((s) => s.metric === METRIC_IDS.containerMemPercent)?.value).toBe(0);
  });
});
