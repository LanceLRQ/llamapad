import { createMockDockerAdapter } from "./mock";
import type { DockerAdapter } from "./types";

/**
 * 适配器工厂（M0 Task 6）
 *
 * PANEL_DOCKER=mock|real：
 * - mock（默认）：内存实现，M0 全程使用
 * - real：M1 落地（dockerode）；当前显式抛错而非静默降级，
 *   避免生产环境误以为已在管理真实容器
 *
 * 单例策略：进程内复用同一实例——mock 的容器表在内存里，共享一个实例
 * 更贴近"单 Docker daemon"语义（多次 getDockerAdapter 的 start/stop 互相可见）；
 * 真实实现将来同样适合单例（一条 docker socket 连接）。
 * 环境变量每次调用都读取：单例缓存的是实例，不缓存配置决策。
 */

let instance: DockerAdapter | null = null;

export function getDockerAdapter(): DockerAdapter {
  const kind = process.env.PANEL_DOCKER ?? "mock";
  if (kind !== "mock") {
    throw new Error(`PANEL_DOCKER=${kind} 尚未支持（M0 仅 mock，real 于 M1 落地 dockerode）`);
  }
  instance ??= createMockDockerAdapter();
  return instance;
}
