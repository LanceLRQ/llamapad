import { getDockerAdapter } from "./adapters";
import type { DockerAdapter } from "./adapters/types";
import { createDownloadManager, type DownloadManager } from "./download/manager";
import { getDb } from "./db";
import { waitForIdle } from "./drain";
import { startEventRetentionTimer } from "./events";
import { parseFakeGpuCount } from "../lib/fake-gpu-count";
import { createFakeGpuExecFile } from "./metrics/fake-gpus";
import { createMetricsCollector, type MetricsCollector } from "./metrics/collector";
import { sumGpuTotals } from "./metrics/latest";
import type { ExecFileLike } from "./metrics/nvidiaSmi";
import { createMetricsStore, type MetricsStore } from "./metrics/store";
import { createNamespaceService, type NamespaceService } from "./namespaces";
import { getModelsHost, getPanelConfig } from "./panelConfig";
import { createRunsRepo, type RunsRepo } from "./runs";
import { createRuntimeService, type RuntimeService } from "./runtime";
import { createWebhookDispatcher, type WebhookDispatcher } from "./webhookDispatcher";

/**
 * 服务定位器（M1 Task 7）：把 RuntimeService 的组装（db + docker 适配器 +
 * panel.yaml 的两个 models 根）收敛为一个进程级单例，风格对齐 db.ts 的 getDb /
 * adapters/index.ts 的 getDockerAdapter——route 与 page 各自内联组装会重复且
 * 难以保持一致，统一从这里取。
 *
 * 单例挂在 globalThis 上：Next 会把 page 与各 API route 编译成独立 bundle，
 * 各自的模块级变量互不共享（观察到 dev 下 page 与 route 各持一份 mock 适配器，
 * 启停后页面看不到运行状态）；挂到全局后所有 bundle 取到同一实例
 * （Prisma 等在 Next 生态的同款惯例）。
 *
 * 注意：单例在首次调用时定格依赖（含 PANEL_DOCKER / PANEL_CONFIG 快照），
 * 与 getDockerAdapter 的 per-kind 缓存语义一致——生产进程内环境不变，
 * 测试不走本模块（直接手工组装传入）。
 */

const globalForRuntime = globalThis as typeof globalThis & {
  __llamapadRuntimeService?: RuntimeService;
};

const globalForAdapter = globalThis as typeof globalThis & {
  __llamapadDockerAdapter?: DockerAdapter;
};

/**
 * docker 适配器全局单例（M3 Task 6）：mock 的容器表在内存里，Next 会把
 * page 与各 API route 编译成独立 bundle、模块级 Map 不共享——各 bundle 各持
 * 一份 mock 实例时会互不可见容器（getRuntimeService 的 globalThis 挂载同款
 * 理由）。RuntimeService / 指标采集 / Playground 反代（getRunningContainerInfo
 * 直查 adapter）都从这里取，保证看到同一张容器表。
 */
export function getSharedDockerAdapter(): DockerAdapter {
  if (!globalForAdapter.__llamapadDockerAdapter) {
    globalForAdapter.__llamapadDockerAdapter = getDockerAdapter();
  }
  return globalForAdapter.__llamapadDockerAdapter;
}

/**
 * 运行时服务单例：host 根用于 docker bind、panel 根用于文件检查。
 *
 * 运行历史（U17）的 GPU 读数 / 区间聚合依赖全部写成惰性箭头函数——函数体内
 * 才调 getMetricsCollector() / getMetricsStore()，不在此处求值。runtime 与
 * metrics collector 互相引用（collector 的 getRuntimeStatus 巡检依赖
 * runtime），提前求值会成环。
 */
export function getRuntimeService(): RuntimeService {
  if (!globalForRuntime.__llamapadRuntimeService) {
    const { models } = getPanelConfig().paths;
    globalForRuntime.__llamapadRuntimeService = createRuntimeService(
      getDb(),
      getSharedDockerAdapter(),
      getModelsHost(),
      models.panel,
      {
        getGpuMemUsedMib: () => sumGpuTotals(getMetricsCollector().nvidiaDevices())?.memUsedMib ?? null,
        getGpuMemTotalMib: () => sumGpuTotals(getMetricsCollector().nvidiaDevices())?.memTotalMib ?? null,
        aggregate: (metric, from, to) => getMetricsStore().aggregateRange(metric, from, to),
        waitForIdle: (args) => waitForIdle(args),
      },
    );
  }
  return globalForRuntime.__llamapadRuntimeService;
}

/** panel 视角的 models 根（decorateModels 的文件扫描根；不存在时 fsScanner 容错为 missing） */
export function getPanelModelsRoot(): string {
  return getPanelConfig().paths.models.panel;
}

const globalForRuns = globalThis as typeof globalThis & {
  __llamapadRunsRepo?: RunsRepo;
};

/**
 * 运行历史仓储单例（U17 T3）：供 GET /api/v1/runs 与 preflight 路由查询用。
 * runtime.ts 内部另建了一份 runsRepo 用于启停时写库——两份实例指向同一个
 * db，prepared statement 各自独立、读写语义完全一致，是可接受的冗余
 * （不为了共用而改 runtime.ts 的构造签名，它已完成并通过验收）。
 */
export function getRunsRepo(): RunsRepo {
  if (!globalForRuns.__llamapadRunsRepo) {
    globalForRuns.__llamapadRunsRepo = createRunsRepo(getDb());
  }
  return globalForRuns.__llamapadRunsRepo;
}

/**
 * 命名空间服务工厂（M1 Task 12）：db + 运行时服务 + 面板视角 models 根的
 * 组装收敛在此（namespaces / models/:name/move 三处 route 共用）。只传
 * panelRoot——namespaces.ts 的全部文件系统操作都走它，宿主视角根只在
 * getRuntimeService() 组装 Docker bind 挂载时才需要（任务 H）。
 * 不做单例缓存：服务本体无状态，每次按需组装（对齐各 route 里
 * createModelRepo(getDb()) 的按需构造风格；prepared statements 建设成本低）。
 */
export function getNamespaceService(): NamespaceService {
  const { models } = getPanelConfig().paths;
  return createNamespaceService(getDb(), getRuntimeService(), {
    panelRoot: models.panel,
  });
}

const globalForDownloads = globalThis as typeof globalThis & {
  __llamapadDownloadManager?: DownloadManager;
};

/**
 * 下载管理服务单例（M2 Task 5）：与 RuntimeService 同款 globalThis 挂载
 * （Next 多 bundle 共享内存队列状态——活动任务句柄只在内存里）。
 * 首次创建时顺带跑一次 recoverOnBoot（面板重启恢复：pending 自动续跑，
 * .part 在的行标 paused 等用户 resume）；失败不阻塞服务可用性，仅吞错。
 */
export function getDownloadManager(): DownloadManager {
  if (!globalForDownloads.__llamapadDownloadManager) {
    const manager = createDownloadManager(getDb(), {
      modelsRoot: getPanelModelsRoot(),
    });
    globalForDownloads.__llamapadDownloadManager = manager;
    void manager.recoverOnBoot().catch((error) => {
      console.error("下载队列启动恢复失败:", error);
    });
  }
  return globalForDownloads.__llamapadDownloadManager;
}

const globalForMetrics = globalThis as typeof globalThis & {
  __llamapadMetricsStore?: MetricsStore;
  __llamapadMetricsCollector?: MetricsCollector;
};

/**
 * 指标存储单例（M3 Task 3）：内存 ring 必须跨 bundle 共享（同 DownloadManager
 * 的 globalThis 挂载理由），创建即启动落盘调度（60s flush + 15min rollup/清理）。
 * 生命周期随进程——面板退出即停，无显式 stop 挂钩（ring 丢失可接受，历史在桶里）。
 */
export function getMetricsStore(): MetricsStore {
  if (!globalForMetrics.__llamapadMetricsStore) {
    const store = createMetricsStore(getDb());
    store.startFlushTimers();
    globalForMetrics.__llamapadMetricsStore = store;
  }
  return globalForMetrics.__llamapadMetricsStore;
}

/**
 * PANEL_FAKE_GPUS 的接线（dev-only 假多卡数据源，见 metrics/fake-gpus.ts）：
 * 没有 NVIDIA 显卡的开发机上，把这个变量设成正整数张数就能在本地看到多卡
 * UI。**必须是 dev-only**——生产环境显示不存在的显卡会让用户按假卡号配
 * 模型，容器起不来，这类故障极难排查，不能让一个环境变量静默造成它，所以
 * NODE_ENV === "production" 时即便变量合法也直接忽略，并 warn 一行说明
 * （而不是默默当没设置，让人以为自己配错了别的地方）。
 * 字符串 → 合法张数的判定已下沉到 lib/fake-gpu-count.ts 做纯函数单测；这里
 * 只是"调用它 + 按结果决定要不要接线"，接线本身不单测（对齐下方
 * getMetricsCollector 注释：纯组装无独立逻辑）。
 */
function resolveFakeGpuExecFile(): ExecFileLike | null {
  const raw = process.env.PANEL_FAKE_GPUS;
  const count = parseFakeGpuCount(raw);
  if (count === null) return null; // 未设置 / 非正整数：当作没配，不报错
  if (process.env.NODE_ENV === "production") {
    console.warn(`[metrics] PANEL_FAKE_GPUS=${raw} 在生产环境下被忽略（仅限 dev-only 假多卡数据源）`);
    return null;
  }
  console.info(`[metrics] PANEL_FAKE_GPUS=${count} 已启用假多卡数据源（dev-only）`);
  return createFakeGpuExecFile(count);
}

/**
 * 指标采集组装单例（M3 Task 3 任务 B）：T2 调度器 + T3 存储的薄壳接线
 * （onSample → store.push），首次取用即开跑 5s 心跳。纯组装无独立逻辑，
 * 不单测——采集器与存储各自在 collector.test.ts / store.test.ts 覆盖；
 * 生命周期随进程（进程退出采集与调度一并终止）。
 *
 * spawn（nvidia-smi 常驻流）刻意不接假数据源：常驻流在 Mac 上本来就会因
 * stdbuf 缺失而静默降级、走 5s 心跳兜底（见 nvidiaSmi.ts 头注释），伪造它
 * 对"本地能看到多卡 UI"这个目标没有增量价值，徒增一份要维护的假实现。
 */
export function getMetricsCollector(): MetricsCollector {
  if (!globalForMetrics.__llamapadMetricsCollector) {
    const store = getMetricsStore();
    const fakeGpuExecFile = resolveFakeGpuExecFile();
    const collector = createMetricsCollector({
      adapter: getSharedDockerAdapter(),
      db: getDb(),
      onSample: (sample) => store.push(sample),
      getRuntimeStatus: () => getRuntimeService().getRuntimeStatus(), // 迟退巡检（model.exit）
      startGpuResidentStream: true, // 真机部署拉起 nvidia-smi 常驻流，供当前值秒级刷新
      modelsRoot: getPanelModelsRoot(), // 宿主机磁盘指标的 statfs 对象（G4）
      startHostStats: true, // 真机部署拉起宿主机指标的 1s 内部定时器
      ...(fakeGpuExecFile !== null ? { execFile: fakeGpuExecFile } : undefined),
    });
    collector.start();
    globalForMetrics.__llamapadMetricsCollector = collector;
  }
  return globalForMetrics.__llamapadMetricsCollector;
}

const globalForEvents = globalThis as typeof globalThis & {
  __llamapadEventRetentionStarted?: boolean;
};

/**
 * events 表保留期定时器单例守卫（events.ts 头注释：90 天保留，设计文档
 * 「events | 事件日志（保留 90 天）」）：与 getMetricsStore() 同款 globalThis
 * 挂载——Next 把 page 与各 API route 编译成独立 bundle，各自 import 会各起
 * 一份 6 小时定时器，重复扫描重复删除（DELETE 本身幂等不会出错，但徒增无谓
 * 的 DB 操作）。首次调用即启动（含首轮立即执行，见 startEventRetentionTimer
 * 头注释）；生命周期随进程——面板退出即停，无显式 stop 挂钩（同
 * getMetricsStore() 的取舍：一个 6 小时节拍的清理任务，不值得为优雅退出
 * 多建机制）。
 */
export function ensureEventRetentionTimer(): void {
  if (globalForEvents.__llamapadEventRetentionStarted) return;
  startEventRetentionTimer(getDb());
  globalForEvents.__llamapadEventRetentionStarted = true;
}

const globalForWebhook = globalThis as typeof globalThis & {
  __llamapadWebhookDispatcher?: WebhookDispatcher;
};

/**
 * Webhook 出站派发器单例（UX P1 U24）：与 MetricsCollector 同款 globalThis
 * 挂载理由（Next 多 bundle 各自 import 会各起一份 setInterval，重复轮询/重复
 * 推送）。首次取用即 start()——不注入 fetchImpl，走 resolveWebhookFetch 的
 * 生产规则（有 panel.yaml proxy 则走代理，否则裸 fetch）。
 */
export function getWebhookDispatcher(): WebhookDispatcher {
  if (!globalForWebhook.__llamapadWebhookDispatcher) {
    const dispatcher = createWebhookDispatcher({ db: getDb() });
    dispatcher.start();
    globalForWebhook.__llamapadWebhookDispatcher = dispatcher;
  }
  return globalForWebhook.__llamapadWebhookDispatcher;
}
