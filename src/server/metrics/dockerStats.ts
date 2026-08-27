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
 *
 * cpuCount（在线核数）同理不进 METRIC_IDS/时序 ring：它在一次运行内是常量，
 * 进时序等于 1440 个相同的点外加每分钟一行数据库桶，纯浪费。只留最近一帧的
 * 值供响应元信息读取（lastCpuCount），前端拿它当 CPU% 的分母做「/ 核数」展示。
 */

export interface DockerStatsCollector {
  /** 一轮采集：运行中返回 cpu/mem/mem_percent 样本，否则空数组 */
  tick(): Promise<Sample[]>;
  /** 最近一帧的 cpuCount；无运行容器 / 从未采集过 → null */
  lastCpuCount(): number | null;
}

export function createDockerStatsCollector(
  adapter: Pick<DockerAdapter, "stats">,
  getRunning: () => Promise<{ name: string } | null>,
): DockerStatsCollector {
  let cpuCount: number | null = null;

  return {
    async tick() {
      const running = await getRunning();
      if (running === null) {
        cpuCount = null; // 没有容器在跑，不该继续显示上一个容器的核数分母
        return [];
      }

      const stats = await adapter.stats(running.name);
      if (stats === null) {
        cpuCount = null; // 容器在 getRunning 与 stats 之间消失，同上
        return [];
      }
      cpuCount = stats.cpuCount;

      const memPercent = stats.memLimitBytes > 0 ? (stats.memBytes / stats.memLimitBytes) * 100 : 0;
      return [
        { metric: METRIC_IDS.containerCpuPercent, value: stats.cpuPercent, ts: stats.ts },
        { metric: METRIC_IDS.containerMemBytes, value: stats.memBytes, ts: stats.ts },
        { metric: METRIC_IDS.containerMemPercent, value: memPercent, ts: stats.ts },
      ];
    },

    lastCpuCount() {
      return cpuCount;
    },
  };
}
