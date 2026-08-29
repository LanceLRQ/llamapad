import { getDockerAdapter } from "./adapters";
import type { DockerAdapter } from "./adapters/types";
import { createDownloadManager, type DownloadManager } from "./download/manager";
import { getDb } from "./db";
import { waitForIdle } from "./drain";
import { recordEvent, startEventRetentionTimer } from "./events";
import { createMetricsCollector, type MetricsCollector } from "./metrics/collector";
import { sumGpuTotals } from "./metrics/latest";
import { createMetricsStore, type MetricsStore } from "./metrics/store";
import { createNamespaceService, type NamespaceService } from "./namespaces";
import { getModelsHost, getPanelConfig } from "./panelConfig";
import { createRunsRepo, type RunsRepo } from "./runs";
import { createRuntimeService, RuntimeBusyError, type RuntimeService } from "./runtime";
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
 * runtime），提前求值会成环，与 U15 的 onAutoStart 回调注入同款处置。
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
 * 命名空间服务工厂（M1 Task 12）：db + 运行时服务 + 两个 models 根的组装
 * 收敛在此（namespaces / models/:name/move 三处 route 共用）。
 * 不做单例缓存：服务本体无状态，每次按需组装（对齐各 route 里
 * createModelRepo(getDb()) 的按需构造风格；prepared statements 建设成本低）。
 */
export function getNamespaceService(): NamespaceService {
  const { models } = getPanelConfig().paths;
  return createNamespaceService(getDb(), getRuntimeService(), {
    panelRoot: models.panel,
    hostRoot: getModelsHost(),
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
      // U15 下载完成自动启动：回调注入（本模块不 import locators 的约定不破）。
      // 防切换守卫在此——后台绝不顶掉正在运行的模型（切换必须是显式动作）；
      // 同模型已在跑（重复入队补下载等场景）也跳过，避免无谓重建容器。
      onAutoStart: async (modelName) => {
        const status = await getRuntimeService().getRuntimeStatus();
        if (status.running !== null) {
          const why =
            status.running.model === modelName
              ? `模型 ${modelName} 已在运行，跳过自动启动`
              : `模型 ${status.running.model} 正在运行，跳过自动启动 ${modelName}（切换需手动确认）`;
          recordEvent(getDb(), "model.auto_start_skipped", why);
          return;
        }
        recordEvent(getDb(), "download.auto_start", `模型 ${modelName} 下载完成，自动启动`);
        try {
          await getRuntimeService().startModel(modelName);
        } catch (error) {
          // 运行时忙（用户正手动启停别的模型）→ 跳过本次自动启动，不冒泡：
          // 自动启动是下载完成后的后台行为，不该因为撞上一次无关的手动操作
          // 就抛出未捕获异常。其余错误（文件缺失/docker 异常等）保持原样冒泡，
          // 不能把真实故障也一并吞掉。
          if (error instanceof RuntimeBusyError) {
            recordEvent(getDb(), "model.auto_start_skipped", `运行时忙，跳过自动启动 ${modelName}`);
            return;
          }
          throw error;
        }
      },
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
 * 指标采集组装单例（M3 Task 3 任务 B）：T2 调度器 + T3 存储的薄壳接线
 * （onSample → store.push），首次取用即开跑 5s 心跳。纯组装无独立逻辑，
 * 不单测——采集器与存储各自在 collector.test.ts / store.test.ts 覆盖；
 * 生命周期随进程（进程退出采集与调度一并终止）。
 */
export function getMetricsCollector(): MetricsCollector {
  if (!globalForMetrics.__llamapadMetricsCollector) {
    const store = getMetricsStore();
    const collector = createMetricsCollector({
      adapter: getSharedDockerAdapter(),
      db: getDb(),
      onSample: (sample) => store.push(sample),
      getRuntimeStatus: () => getRuntimeService().getRuntimeStatus(), // 迟退巡检（model.exit）
      startGpuResidentStream: true, // 真机部署拉起 nvidia-smi 常驻流，供当前值秒级刷新
      modelsRoot: getPanelModelsRoot(), // 宿主机磁盘指标的 statfs 对象（G4）
      startHostStats: true, // 真机部署拉起宿主机指标的 1s 内部定时器
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
