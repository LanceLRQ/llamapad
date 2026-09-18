/**
 * 容器名与宿主机端口分配（多模型并行，决策 D2 / D3）
 *
 * 多个模型不覆盖 docker.container_name / docker.host_port 时，合并配置得到的都是
 * 默认的 llama-server / 18080。单模型时代这从来不冲突（启动前会先把别的停掉），
 * 放开并行后必须在启动前错开，否则：
 * - 容器名相同：适配器的 recreate 语义（dockerode 的 removeIfExists 是 rm -f）
 *   会把正在跑的另一个模型直接强杀，且绕过 stopModel 的记账（run 不关闭、事件不记）
 * - 端口相同：docker 在 container.start 时才报 port is already allocated
 *
 * 优先级：配置值（模型覆盖 > 默认配置）能用就用，被占才顺延。这样单模型用户
 * 升级后端口不变，nginx 反代与客户端直连 18080 的配置都不受影响。
 *
 * 本文件只做「给定占用集合，算出一个不冲突的槽位」，占用集合从哪来（运行中的
 * 容器 label、进程内占位表、TCP 探测结果）由 runtime.ts 组装。
 */

/** 分配结果：容器名 + 宿主机端口 */
export interface ContainerSlot {
  name: string;
  hostPort: number;
}

export interface SlotAllocationInput {
  /** 待启动的模型名（容器名冲突时作为后缀；模型名只含小写字母数字与连字符，拼进容器名合法） */
  model: string;
  /** 合并配置得到的容器名 */
  configuredName: string;
  /** 合并配置得到的宿主机端口 */
  configuredPort: number;
  /** 已被其他模型占用的容器名 */
  takenNames: ReadonlySet<string>;
  /** 已被占用的端口（其他模型占用 + 探测到被宿主机其他进程占用） */
  takenPorts: ReadonlySet<number>;
}

export const MAX_HOST_PORT = 65_535;

/** 从配置端口一路顺延到 65535 都被占用（实际几乎不可能，防御性兜底） */
export class PortExhaustedError extends Error {
  constructor(readonly fromPort: number) {
    super(`从端口 ${fromPort} 起到 ${MAX_HOST_PORT} 均被占用，无法为模型分配宿主机端口`);
    Object.setPrototypeOf(this, PortExhaustedError.prototype);
  }
}

function allocateName(model: string, configuredName: string, taken: ReadonlySet<string>): string {
  if (!taken.has(configuredName)) return configuredName;
  const base = `${configuredName}-${model}`;
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function allocatePort(configuredPort: number, taken: ReadonlySet<number>): number {
  for (let port = configuredPort; port <= MAX_HOST_PORT; port++) {
    if (!taken.has(port)) return port;
  }
  throw new PortExhaustedError(configuredPort);
}

export function allocateContainerSlot(input: SlotAllocationInput): ContainerSlot {
  return {
    name: allocateName(input.model, input.configuredName, input.takenNames),
    hostPort: allocatePort(input.configuredPort, input.takenPorts),
  };
}

/**
 * docker 的端口冲突报错识别。两种形态都出现过：
 * - `Bind for 0.0.0.0:18080 failed: port is already allocated`（端口被另一个容器发布）
 * - `listen tcp4 0.0.0.0:18080: bind: address already in use`（被宿主机进程占用）
 * TCP 探测挡不住的情况（比如宿主机进程只监听 127.0.0.1，面板容器探测不到）靠它兜底。
 */
export function isPortBindError(message: string): boolean {
  return /port is already allocated|address already in use/i.test(message);
}
