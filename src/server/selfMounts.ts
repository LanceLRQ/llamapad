import type { ContainerMount, DockerAdapter } from "./adapters/types";

/**
 * 自动发现 models 宿主机根（models 目录自动发现，2026-08-28）
 *
 * 面板要替 llama.cpp 兄弟容器写 docker bind 参数，必须知道模型目录在宿主机
 * 上的绝对路径。这个值以前只能靠用户手写在 panel.yaml，写错了表现极隐蔽
 * （面板一切正常，一点启动才挂不上）。本模块用面板自己的 docker.sock 查
 * "自己容器"的挂载表，找到挂到面板侧 models 路径（compose 固定约定
 * /host-models）上的那个 bind，读出它的 Source——那就是宿主机绝对路径，
 * 不需要用户再抄一遍。
 */

/** Docker 默认把容器 ID 前 12 位写进容器的 HOSTNAME（`docker run`/compose 不显式指定 hostname 时的内置行为） */
const CONTAINER_ID_PATTERN = /^[0-9a-f]{12}$/;

/**
 * 自身容器 id：Docker 默认把容器 ID 前 12 位写进容器的 HOSTNAME。
 * 被显式覆盖（compose 的 hostname:）或非容器环境下取不到有效值，返回 null——
 * 用格式校验而非"存在即用"，避免把用户自定义 hostname 错当容器 id 去 inspect
 * （查不到自己是小事，误撞到别的同名容器会查出一份无意义的挂载表）。
 */
export function selfContainerId(env: NodeJS.ProcessEnv = process.env): string | null {
  const hostname = env.HOSTNAME;
  return hostname !== undefined && CONTAINER_ID_PATTERN.test(hostname) ? hostname : null;
}

/** 在挂载表里找 destination 精确命中的 bind 源；非 bind 类型跳过，无命中返回 null */
export function findBindSource(mounts: readonly ContainerMount[], destination: string): string | null {
  const hit = mounts.find((m) => m.type === "bind" && m.destination === destination);
  return hit?.source ?? null;
}

/**
 * 自动发现 models 的宿主机根：查自身容器挂载表 → 找挂到 panelPath 的 bind。
 * 任何一步取不到（非容器环境 / 查不到自身 / 无命中 / docker 不可用）一律返回 null，
 * 绝不抛错——它是优先级链里的兜底级，失败必须安静降级给 Doctor 去报。
 */
export async function discoverHostModelsRoot(
  adapter: DockerAdapter,
  panelPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const containerId = selfContainerId(env);
  if (containerId === null) return null;
  try {
    const mounts = await adapter.inspectMounts(containerId);
    if (mounts === null) return null;
    return findBindSource(mounts, panelPath);
  } catch {
    // docker.sock 不可达 / 权限不足等：与"查不到"同等对待，安静降级
    return null;
  }
}
