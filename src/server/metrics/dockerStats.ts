import type { ContainerStatsSample, DockerAdapter } from "../adapters/types";
import { METRIC_IDS, type Sample } from "./ids";

/**
 * docker stats 采集器（M3 Task 2；秒级指标采集 代号 B 补充优先读流）
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
 *
 * getLatestFrame（可选注入）：`GET /containers/.../stats?stream=false` 在
 * 真机上单次要阻塞 1-2s（daemon 得自己等两个采样点算 CPU%），5s 心跳没必要
 * 每轮都白等这一下——若调用方（collector.ts）已经通过秒级 follow 流维护着
 * 一份"最新一帧"，优先用它，只有无流帧（未注入 / 尚未收到帧）时才回落到
 * 阻塞的 adapter.stats()。不传该参数或返回 null 时行为与改动前完全一致。
 */

export interface DockerStatsCollector {
  /** 一轮采集：运行中返回 cpu/mem/mem_percent 样本，否则空数组 */
  tick(): Promise<Sample[]>;
  /** 最近一帧的 cpuCount；无运行容器 / 从未采集过 → null */
  lastCpuCount(): number | null;
}

/**
 * 单帧 → 三样本换算（fresh 帧、adapter.stats() 兜底帧共用同一份公式）。
 * 导出供 collector.ts 复用：秒级快照（latestFastSamples）用同一份帧
 * 转出 route 要的样本形态，避免 mem_percent 公式两处漂移。
 */
export function samplesFromFrame(stats: ContainerStatsSample): Sample[] {
  const memPercent = stats.memLimitBytes > 0 ? (stats.memBytes / stats.memLimitBytes) * 100 : 0;
  return [
    { metric: METRIC_IDS.containerCpuPercent, value: stats.cpuPercent, ts: stats.ts },
    { metric: METRIC_IDS.containerMemBytes, value: stats.memBytes, ts: stats.ts },
    { metric: METRIC_IDS.containerMemPercent, value: memPercent, ts: stats.ts },
  ];
}

export function createDockerStatsCollector(
  adapter: Pick<DockerAdapter, "stats">,
  getRunning: () => Promise<{ name: string } | null>,
  getLatestFrame?: () => ContainerStatsSample | null,
): DockerStatsCollector {
  let cpuCount: number | null = null;

  return {
    async tick() {
      const running = await getRunning();
      if (running === null) {
        cpuCount = null; // 没有容器在跑，不该继续显示上一个容器的核数分母
        return [];
      }

      // 优先用秒级流已经攒好的最新帧，避免每轮都白等 adapter.stats() 的 1-2s 阻塞；
      // 无流帧（未注入 / 尚未收到）才回落到原有的阻塞查询路径
      const stats = getLatestFrame?.() ?? (await adapter.stats(running.name));
      if (stats === null) {
        cpuCount = null; // 容器在 getRunning 与取帧之间消失，同上
        return [];
      }
      cpuCount = stats.cpuCount;
      return samplesFromFrame(stats);
    },

    lastCpuCount() {
      return cpuCount;
    },
  };
}
