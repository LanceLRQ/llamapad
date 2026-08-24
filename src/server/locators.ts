import { getDockerAdapter } from "./adapters";
import { getDb } from "./db";
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
