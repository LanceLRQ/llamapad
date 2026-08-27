import type Database from "better-sqlite3";
import type { ContainerStatsSample, DockerAdapter } from "../adapters/types";
import { getRunningContainerInfo } from "../runtime";
import { createDockerStatsCollector, samplesFromFrame } from "./dockerStats";
import { createHealthCollector, type FetchLike } from "./health";
import { createHostStatsCollector, type HostStatsCollector, type HostStatsDeps } from "./hostStats";
import { METRIC_IDS, type Sample } from "./ids";
import {
  createNvidiaSmiCollector,
  type ExecFileLike,
  type GpuDevice,
  type NvidiaStatus,
  type SpawnLike,
} from "./nvidiaSmi";

/**
 * 指标调度器（M3 Task 2）：5s 心跳统一驱动三类采集器，
 * 样本逐个喂 onSample 回调（T3 的 metrics store 消费）。
 *
 * 组装：
 * - dockerStats 需要运行容器名、health 需要运行模型的 host_port——两者
 *   同源于 runtime 的 getRunningContainerInfo（label 推导 + mergeConfig），
 *   每轮 tick 只查一次 docker，两个采集器经闭包共享该 Promise
 * - nvidiaSmi 启动时 probe 一次；失败后由 tick 按固定间隔周期性重探
 *   （见 nvidiaSmi.ts 的 RETRY_INTERVAL_MS——M4 真机实测：单向闸门会让
 *   一次瞬时失败永久关闭 GPU 监控），isNvidiaAvailable 供 UI 查询
 *
 * 韧性：单个采集器 tick 抛错（docker 抖动等）只丢弃本轮其样本，
 * 不拖垮心跳，下一轮照常。
 *
 * 分母透传（T3）：GPU 分卡明细（devices）与 CPU 核数（cpuCount）不进
 * 时序 ring（一次运行内是常量，进时序纯浪费），只转发采集器内部已有的
 * 最近一帧快照，供 gpu/stats、container/stats 两个响应挂在元信息里。
 *
 * 秒级快照（代号 B）：本调度器额外持有一条容器 followStats 订阅（进程级
 * 单例，不随请求起订阅），随「谁在运行」的判定一起换订阅——判定复用上面
 * 已有的 runningInfo() 缓存，换订阅/清句柄的时机就挂在现有 5s tick 里，
 * 不另起定时器。秒级帧只维护"最近一帧"（lastContainerFrame），
 * 两处消费：① dockerStats 的 tick() 优先读它，省掉阻塞的 adapter.stats()；
 * ② latestFastSamples() 转成 route 要的样本形态供 currentValue 覆盖合并
 * （metrics/latest.ts）。GPU 秒级快照同理转发自 nvidiaSmi 的常驻流，
 * 但其生命周期不跟随容器切换，只跟随 start()/stop()。
 * 这条快照完全不进时序 ring / SQLite 桶，5s 心跳与历史曲线链路不受影响。
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
  /** 测试注入点：透传给 nvidia-smi 常驻流（缺省 node spawn） */
  spawn?: SpawnLike;
  /**
   * 是否在 start() 时一并拉起 GPU 常驻流子进程（真机部署应为 true，见
   * locators.ts）。默认 false——常驻流是会一直跑到显式 stop 的真实子进程
   * （`-lms 1000` 无限循环），不像 execFile/fetch 那样一次调用就完事，
   * 测试环境不该在没有显式声明的情况下背着调用方起真实长驻进程。
   */
  startGpuResidentStream?: boolean;
  /** 迟退巡检（M4 真机）：每轮 tick 调一次 runtime 的 getRuntimeStatus，
   *  触发容器异常消失的迁移检测（model.exit 事件）。缺省不巡检 */
  getRuntimeStatus?: () => Promise<unknown>;
  /** models 根路径（G4 宿主机磁盘指标的 statfs 对象）；未提供时宿主机磁盘
   *  样本恒缺失，其余宿主机指标（CPU/内存/负载/网络）不受影响 */
  modelsRoot?: string;
  /** 测试注入点：透传给宿主机指标采集器（缺省真实 os/fs 实现）；
   *  db/modelsRoot 恒由本对象顶层同名字段决定，此处传入会被忽略 */
  hostStatsDeps?: Partial<HostStatsDeps>;
  /**
   * 是否在 start() 时一并拉起宿主机指标的 1s 内部定时器（真机部署应为
   * true，见 locators.ts）。默认 false——与 startGpuResidentStream 同款
   * 理由：这是会一直跑到显式 stop 的真实定时器，读的是真实 os 系统调用与 /proc，
   * 测试环境不该在没有显式声明的情况下背着调用方产出真实系统的 CPU/内存
   * 数值，污染既有"无数据 → 空对象"的断言。
   */
  startHostStats?: boolean;
}

export interface MetricsCollector {
  /** 启动心跳（幂等）；同时做一次 nvidia-smi 特性探测 */
  start(): void;
  /** 停止心跳（幂等） */
  stop(): void;
  /** nvidia-smi 可用性（供 UI 查询；探测完成前恒 false） */
  isNvidiaAvailable(): boolean;
  /** nvidia-smi 三态探测状态（供 UI 区分"探测中"与"确认不可用"） */
  nvidiaStatus(): NvidiaStatus;
  /** 分卡明细透传（gpu/stats 消费） */
  nvidiaDevices(): GpuDevice[];
  /** 最近一帧 CPU 核数透传（container/stats 消费） */
  lastCpuCount(): number | null;
  /**
   * 秒级快照（代号 B）：容器 cpu/mem/mem_percent（followStats 订阅）+
   * GPU mem_used/util（nvidia 常驻流）+ 宿主机指标（G4，hostStats 自带的
   * 1s 定时器）合并成一份，键为 MetricId。尚无秒级数据的指标不出键——
   * route 层与 ring 样本按 ts 覆盖合并（metrics/latest.ts 的
   * overlayLatestSamples）时天然回退到 ring 值。
   */
  latestFastSamples(): { [metric: string]: { value: number; ts: number } };
  /** 宿主机分母透传（host/stats 消费）：CPU 核数/内存总量/磁盘总量，
   *  尚未采到 → null（与 lastCpuCount 同款"一次运行内常量不进时序"处理） */
  hostDenominators(): { cpuCount: number | null; memTotalBytes: number | null; diskTotalBytes: number | null };
}

export function createMetricsCollector(deps: MetricsCollectorDeps): MetricsCollector {
  // 每轮共享的运行信息查询缓存：tick 开头置空，dockerStats / health 的
  // getRunning / getTarget 首个触发者发起查询，后来者复用同一 Promise
  let pendingRunning: Promise<Awaited<ReturnType<typeof getRunningContainerInfo>>> | null = null;
  const runningInfo = () =>
    (pendingRunning ??= getRunningContainerInfo(deps.db, deps.adapter));

  // 秒级容器帧订阅状态：当前订阅的容器名（null=未订阅）、句柄、最新一帧
  let followedContainer: string | null = null;
  let followHandle: { stop(): Promise<void> } | null = null;
  let lastContainerFrame: ContainerStatsSample | null = null;

  const dockerStats = createDockerStatsCollector(
    deps.adapter,
    async () => {
      const info = await runningInfo();
      return info === null ? null : { name: info.container };
    },
    () => lastContainerFrame,
  );

  const health = createHealthCollector(async () => {
    const info = await runningInfo();
    return info !== null && info.hostPort !== null ? { hostPort: info.hostPort } : null;
  }, deps.fetch !== undefined ? { fetch: deps.fetch } : undefined);

  const nvidia = createNvidiaSmiCollector({
    ...(deps.execFile !== undefined ? { execFile: deps.execFile } : undefined),
    ...(deps.spawn !== undefined ? { spawn: deps.spawn } : undefined),
  });

  // 宿主机指标（G4）：读 /proc 与 os.* 系统调用，比 docker stats 还便宜，
  // 自带 1s 内部定时器（不像 GPU 常驻流需要子进程，也不需要 startGpuResidentStream
  // 那样的显式开关——真机部署恒开，未挂 /host/proc 时相关指标自行降级）。
  // db/modelsRoot 恒由本对象顶层字段决定，测试注入（hostStatsDeps）不能覆盖它们。
  const hostStats: HostStatsCollector = createHostStatsCollector({
    ...deps.hostStatsDeps,
    db: deps.db,
    modelsRoot: deps.modelsRoot,
  });

  /**
   * 容器切换 → 换订阅；这里被现有 5s tick 驱动，不另起定时器。
   * 无论切到别的容器还是切到"无运行"，旧帧都先清掉——它不再代表当前状态，
   * 留着会在 latestFastSamples() 里展示一个已经不存在的容器的冻结值。
   */
  async function ensureContainerFollow(name: string | null): Promise<void> {
    if (name === followedContainer) return; // 未切换，维持现有订阅
    const previousHandle = followHandle;
    followedContainer = name;
    followHandle = null;
    lastContainerFrame = null;
    if (previousHandle !== null) await previousHandle.stop();
    if (name === null) return; // 无运行容器：不建立新订阅

    followHandle = await deps.adapter.followStats(name, (sample) => {
      // 订阅之间可能有迟到帧：只有当前仍是该容器时才写入快照
      if (followedContainer !== name) return;
      lastContainerFrame = sample;
    });
  }

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
    // 常驻流自愈：startResident() 幂等 + 内部节流，在跑时是空操作，
    // 异常退出后节流窗口一过、下一轮 tick 自然把它重新拉起来（不额外起定时器）
    if (deps.startGpuResidentStream === true) nvidia.startResident();
    const info = await runningInfo();
    await ensureContainerFollow(info === null ? null : info.container);
    for (const collector of [dockerStats, health, nvidia, hostStats]) {
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
      // 特性探测启动即做一次；失败后由 tick 按节流间隔周期性重探
      // （见 nvidiaSmi.ts）。不 await——probe 慢（起子进程）不该阻塞心跳的建立
      void nvidia.probe();
      // 常驻流的生命周期跟随 start()/stop()，不跟随容器切换（GPU 是主机级资源）；
      // 显式开关（见上方字段注释），默认不拉起。这里调一次是为了面板启动时
      // 立即拉起（不等第一个 5s tick）；tick() 里还会每轮再调一次做自愈
      // （见 tick() 内注释），两处都调是安全的——startResident() 幂等 + 节流
      if (deps.startGpuResidentStream === true) nvidia.startResident();
      // 宿主机指标：显式开关（见上方字段注释），默认不拉起，真机部署恒开
      if (deps.startHostStats === true) hostStats.start();
      timer = setInterval(() => void tick(), deps.intervalMs ?? METRICS_INTERVAL_MS);
    },

    stop() {
      if (timer === undefined) return; // 幂等
      clearInterval(timer);
      timer = undefined;
      nvidia.stopResident(); // 未曾 startResident 过则是幂等空操作，直接调用更简单可靠
      hostStats.stop();
      // 停止容器秒级订阅；stop() 保持同步语义，清理动作 fire-and-forget
      // （mock/dockerode 的 stop() 内部同步部分——clearInterval/destroy——
      // 已经生效，只有等待收尾的部分是异步的，不需要在这里等）
      const handle = followHandle;
      followedContainer = null;
      followHandle = null;
      lastContainerFrame = null;
      if (handle !== null) void handle.stop();
    },

    isNvidiaAvailable() {
      return nvidia.isAvailable();
    },

    nvidiaStatus() {
      return nvidia.status();
    },

    nvidiaDevices() {
      return nvidia.devices();
    },

    lastCpuCount() {
      return dockerStats.lastCpuCount();
    },

    latestFastSamples() {
      const result: { [metric: string]: { value: number; ts: number } } = {};
      if (lastContainerFrame !== null) {
        for (const sample of samplesFromFrame(lastContainerFrame)) {
          result[sample.metric] = { value: sample.value, ts: sample.ts };
        }
      }
      const gpu = nvidia.latestStreamSample();
      if (gpu !== null) {
        result[METRIC_IDS.gpuMemUsedMib] = { value: gpu.memUsedMib, ts: gpu.ts };
        result[METRIC_IDS.gpuUtilPercent] = { value: gpu.utilPercent, ts: gpu.ts };
      }
      Object.assign(result, hostStats.latestFastSamples());
      return result;
    },

    hostDenominators() {
      return hostStats.denominators();
    },
  };
}
