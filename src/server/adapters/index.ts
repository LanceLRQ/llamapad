import { createDockerodeAdapter } from "./dockerode";
import { createMockDockerAdapter } from "./mock";
import type { DockerAdapter } from "./types";

/**
 * 适配器工厂（M0 Task 6；M1 Task 5 落地 real）
 *
 * PANEL_DOCKER=mock|real：
 * - mock（默认）：内存实现
 * - real：dockerode 实现（默认 socket /var/run/docker.sock，PANEL_DOCKER_SOCKET 覆盖）
 * - 其他值：显式抛错而非静默降级，避免生产环境误以为已在管理真实容器
 *
 * 单例策略：进程内复用同一实例——mock 的容器表在内存里，共享一个实例
 * 更贴近"单 Docker daemon"语义（多次 getDockerAdapter 的 start/stop 互相可见）；
 * 真实实现同样适合单例（一条 docker socket 连接，dockerode 连接惰性建立）。
 * 单例按 kind 分开缓存：环境变量每次调用都读取，切换 mock/real 后取到
 * 对应实现（同一 kind 的重复调用仍返回同一实例）。
 */

const instances = new Map<string, DockerAdapter>();

export function getDockerAdapter(): DockerAdapter {
  const kind = process.env.PANEL_DOCKER ?? "mock";
  if (kind !== "mock" && kind !== "real") {
    throw new Error(`PANEL_DOCKER=${kind} 无效（可用值：mock | real）`);
  }
  let instance = instances.get(kind);
  if (!instance) {
    instance = kind === "real" ? createDockerodeAdapter() : createMockDockerAdapter();
    instances.set(kind, instance);
  }
  return instance;
}
