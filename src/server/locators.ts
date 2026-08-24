import { getDockerAdapter } from "./adapters";
import { createDownloadManager, type DownloadManager } from "./download/manager";
import { getDb } from "./db";
import { createNamespaceService, type NamespaceService } from "./namespaces";
import { getPanelConfig } from "./panelConfig";
import { createRuntimeService, type RuntimeService } from "./runtime";

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

/** 运行时服务单例：host 根用于 docker bind、panel 根用于文件检查 */
export function getRuntimeService(): RuntimeService {
  if (!globalForRuntime.__llamapadRuntimeService) {
    const { models } = getPanelConfig().paths;
    globalForRuntime.__llamapadRuntimeService = createRuntimeService(
      getDb(),
      getDockerAdapter(),
      models.host,
      models.panel,
    );
  }
  return globalForRuntime.__llamapadRuntimeService;
}

/** panel 视角的 models 根（decorateModels 的文件扫描根；不存在时 fsScanner 容错为 missing） */
export function getPanelModelsRoot(): string {
  return getPanelConfig().paths.models.panel;
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
    hostRoot: models.host,
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
    const manager = createDownloadManager(getDb(), { modelsRoot: getPanelModelsRoot() });
    globalForDownloads.__llamapadDownloadManager = manager;
    void manager.recoverOnBoot().catch((error) => {
      console.error("下载队列启动恢复失败:", error);
    });
  }
  return globalForDownloads.__llamapadDownloadManager;
}
