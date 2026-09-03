import type { ContainerMount, DockerAdapter } from "./adapters/types";
import { selfContainerId } from "./selfMounts";
import type { PathMap } from "@/core/paths";

/**
 * 可用导入源发现（本地权重迁移 设计 §6.1）
 *
 * 面板是容器，只看得见 compose 挂进来的路径。用户填一个宿主机路径时，能不能
 * 访问完全取决于有没有对应的 bind——所以与其让用户猜，不如把面板自己的挂载表
 * 读出来，既做换算映射（PathMap 的形状与 (source, destination) 一模一样），
 * 也做「当前可用范围」的提示与校验。
 *
 * 手法与 selfMounts.discoverHostModelsRoot 同源，只是那边找一个特定 destination，
 * 这边要全部。
 */

/** 面板运行必需、绝不会用来放模型的挂载点 */
const EXCLUDED_DESTINATIONS = new Set(["/app/config", "/host/proc", "/var/run/docker.sock"]);

/**
 * 从挂载表筛出可作为导入源的 bind，models 那组恒排首位。
 * 非 bind（volume / tmpfs）一律排除：它们没有宿主机路径可言。
 */
export function importableMounts(
  mounts: readonly ContainerMount[],
  modelsPanelRoot: string,
): PathMap[] {
  const usable = mounts
    .filter((m) => m.type === "bind" && !EXCLUDED_DESTINATIONS.has(m.destination))
    .map((m) => ({ host: m.source, panel: m.destination }));

  const modelsIdx = usable.findIndex((m) => m.panel === modelsPanelRoot);
  if (modelsIdx <= 0) return usable;
  const [models] = usable.splice(modelsIdx, 1);
  return [models!, ...usable];
}

/**
 * 发现结果的进程级存放处。挂 globalThis 而不是模块级变量——Next 多 bundle
 * 不共享模块作用域，这是 models 根自动发现（panelConfig.ts 的
 * globalForDiscoveredHost）踩过并写进注释的既有结论，此处沿用同一手法与
 * 同一类型化写法（键名打错字逃不过 tsc，普通 `Record<string, unknown>`
 * 索引做不到这点）。
 */
const globalForMounts = globalThis as typeof globalThis & {
  __llamapadImportableMounts?: PathMap[];
};

export function setDiscoveredMounts(maps: readonly PathMap[]): void {
  globalForMounts.__llamapadImportableMounts = [...maps];
}

/** 未发现（非容器环境 / docker 不可达）时返回空数组，调用方一律按「只有 models」处理 */
export function getDiscoveredMounts(): PathMap[] {
  return globalForMounts.__llamapadImportableMounts ?? [];
}

/** 查自身容器挂载表；任何一步取不到一律返回空数组，绝不抛错（同 discoverHostModelsRoot 的降级契约） */
export async function discoverImportableMounts(
  adapter: DockerAdapter,
  modelsPanelRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PathMap[]> {
  const containerId = selfContainerId(env);
  if (containerId === null) return [];
  try {
    const mounts = await adapter.inspectMounts(containerId);
    if (mounts === null) return [];
    return importableMounts(mounts, modelsPanelRoot);
  } catch {
    return [];
  }
}
