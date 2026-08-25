import type Database from "better-sqlite3";
import type { DockerAdapter } from "../adapters/types";
import { getRunningContainerInfo } from "../runtime";
import { createDockerStatsCollector } from "./dockerStats";
import { createHealthCollector, type FetchLike } from "./health";
import type { Sample } from "./ids";
import { createNvidiaSmiCollector, type ExecFileLike } from "./nvidiaSmi";

/**
 * 指标调度器（M3 Task 2）：5s 心跳统一驱动三类采集器，
 * 样本逐个喂 onSample 回调（T3 的 metrics store 消费）。
 *
 * 组装：
 * - dockerStats 需要运行容器名、health 需要运行模型的 host_port——两者
 *   同源于 runtime 的 getRunningContainerInfo（label 推导 + mergeConfig），
 *   每轮 tick 只查一次 docker，两个采集器经闭包共享该 Promise
 * - nvidiaSmi 启动时 probe 一次；失败不重试（本机无 NVIDIA 是常态，
 *   重探策略留 M4 真机再评估），isNvidiaAvailable 供 UI 查询
 *
 * 韧性：单个采集器 tick 抛错（docker 抖动等）只丢弃本轮其样本，
 * 不拖垮心跳，下一轮照常。
 */

/** 心跳间隔默认值 */
export const METRICS_INTERVAL_MS = 5_000;

export interface MetricsCollectorDeps {
  adapter: DockerAdapter;
  db: Database.Database;
  /** 样本出口：每轮 tick 的每个样本逐个回调（T3 store 接这里） */
  onSample: (sample: Sample) => void;
  /** 心跳间隔（毫秒）；缺省 5s */
  intervalMs?: number;
  /** 测试注入点：透传给 health 采集器（缺省全局 fetch） */
  fetch?: FetchLike;
  /** 测试注入点：透传给 nvidia-smi 采集器（缺省 node execFile） */
  execFile?: ExecFileLike;
  /** 迟退巡检（M4 真机）：每轮 tick 调一次 runtime 的 getRuntimeStatus，
   *  触发容器异常消失的迁移检测（model.exit 事件）。缺省不巡检 */
  getRuntimeStatus?: () => Promise<unknown>;
}

export interface MetricsCollector {
  /** 启动心跳（幂等）；同时做一次 nvidia-smi 特性探测 */
  start(): void;
  /** 停止心跳（幂等） */
  stop(): void;
  /** nvidia-smi 可用性（供 UI 查询；探测完成前恒 false） */
  isNvidiaAvailable(): boolean;
}

export function createMetricsCollector(deps: MetricsCollectorDeps): MetricsCollector {
  // 每轮共享的运行信息查询缓存：tick 开头置空，dockerStats / health 的
  // getRunning / getTarget 首个触发者发起查询，后来者复用同一 Promise
  let pendingRunning: Promise<Awaited<ReturnType<typeof getRunningContainerInfo>>> | null = null;
  const runningInfo = () =>
    (pendingRunning ??= getRunningContainerInfo(deps.db, deps.adapter));

  const dockerStats = createDockerStatsCollector(deps.adapter, async () => {
    const info = await runningInfo();
    return info === null ? null : { name: info.container };
  });

  const health = createHealthCollector(async () => {
    const info = await runningInfo();
    return info !== null && info.hostPort !== null ? { hostPort: info.hostPort } : null;
  }, deps.fetch !== undefined ? { fetch: deps.fetch } : undefined);

  const nvidia = createNvidiaSmiCollector(
    deps.execFile !== undefined ? { execFile: deps.execFile } : undefined,
  );

  let timer: ReturnType<typeof setInterval> | undefined;

  async function tick(): Promise<void> {
    pendingRunning = null; // 作废上一轮缓存，本轮重新查一次
    if (deps.getRuntimeStatus !== undefined) {
      try {
        await deps.getRuntimeStatus(); // 迟退巡检：副作用是迁移检测（model.exit）
      } catch {
        // 巡检失败不影响指标采集
      }
    }
    for (const collector of [dockerStats, health, nvidia]) {
      try {
        for (const sample of await collector.tick()) deps.onSample(sample);
      } catch {
        // 单采集器异常不拖垮心跳：本轮丢弃其样本，下一轮再来
      }
    }
  }

  return {
    start() {
      if (timer !== undefined) return; // 幂等
      // 特性探测启动即做一次，失败不重试（重探策略 M4 真机再评估）；
      // 不 await——probe 慢（起子进程）不该阻塞心跳的建立
      void nvidia.probe();
      timer = setInterval(() => void tick(), deps.intervalMs ?? METRICS_INTERVAL_MS);
    },

    stop() {
      if (timer === undefined) return; // 幂等
      clearInterval(timer);
      timer = undefined;
    },

    isNvidiaAvailable() {
      return nvidia.isAvailable();
    },
  };
}
