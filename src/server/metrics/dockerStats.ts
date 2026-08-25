import type { DockerAdapter } from "../adapters/types";
import { METRIC_IDS, type Sample } from "./ids";

/**
 * docker stats 采集器（M3 Task 2）
 *
 * 每轮 tick：查"谁在运行"→ 拉容器资源单帧 → 拍成样本。
 * 无运行容器 / 容器消失（stats null）→ 无样本（面板语义：停了就没数据，
 * 不产 0 值样本，避免图表上"停机=0 负载"的误导）。
 *
 * 取舍：netRx/netTx 在 ContainerStatsSample 里采集，但 METRIC_IDS 未定义
 * 对应指标（T3 store 不画网络图），故不产出——预留在适配层，后续要加只动这里。
 */

export interface DockerStatsCollector {
  /** 一轮采集：运行中返回 cpu/mem/mem_percent 样本，否则空数组 */
  tick(): Promise<Sample[]>;
}

export function createDockerStatsCollector(
  adapter: Pick<DockerAdapter, "stats">,
  getRunning: () => Promise<{ name: string } | null>,
): DockerStatsCollector {
  return {
    async tick() {
      const running = await getRunning();
      if (running === null) return [];

      const stats = await adapter.stats(running.name);
      if (stats === null) return []; // 容器在 getRunning 与 stats 之间消失

      const memPercent = stats.memLimitBytes > 0 ? (stats.memBytes / stats.memLimitBytes) * 100 : 0;
      return [
        { metric: METRIC_IDS.containerCpuPercent, value: stats.cpuPercent, ts: stats.ts },
        { metric: METRIC_IDS.containerMemBytes, value: stats.memBytes, ts: stats.ts },
        { metric: METRIC_IDS.containerMemPercent, value: memPercent, ts: stats.ts },
      ];
    },
  };
}
