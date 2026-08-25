/**
 * Docker 适配层接口（M0 Task 6）
 *
 * M0 全程不依赖真实 Docker：本文件只定义接口形态，实现仅有内存 mock
 * （./mock.ts）；real 实现（dockerode）在 M1 落地。
 *
 * ContainerSpec 是"启动一个 llama-server 容器"所需的全部信息，
 * 由 effectiveParams/mergeConfig 的合并结果 + 模型信息组装：
 * docker 段 → name/image/端口/卷/GPU，server 段 → buildArgs 产出 args。
 */

/** 启动一个容器所需的完整描述 */
export interface ContainerSpec {
  /** 容器名（对应 default 配置 docker.container_name） */
  name: string;
  /** 镜像（对应 docker.image，如 ghcr.io/ggmlorg/llama.cpp:server-cuda） */
  image: string;
  /** 宿主机端口（docker run -p 的左侧） */
  hostPort: number;
  /** 容器内端口（docker run -p 的右侧；同时作为 --port 传入 llama-server） */
  containerPort: number;
  /** bind mount 卷，形如 "/host:/container"（对应 docker.model_volume） */
  volume: string;
  /** GPU 选择："all" | "none" | "device=N[,N…]"（对应 docker.gpu） */
  gpu: string;
  /** 容器标签，如 { "llamapad.managed": "true" }，用于辨识本面板管理的容器 */
  labels: Record<string, string>;
  /** llama-server 完整 CLI 参数（由 core/args.ts 的 buildArgs 产出，不含程序名） */
  args: string[];
}

/** 容器状态快照 */
export interface ContainerStatus {
  name: string;
  id: string;
  state: "running" | "exited" | "created";
  startedAt: string | null;
  /** 容器标签（docker inspect 的 Config.Labels）；"谁是当前运行模型"等
   *  判定从 label 读取而非内存状态，面板重启后可自愈 */
  labels?: Record<string, string>;
}

/**
 * Docker 适配器：面板对"容器生命周期"的全部依赖收敛在这些方法后面，
 * mock 与 real（M1 dockerode）可互换。
 */
export interface DockerAdapter {
  /** 创建并启动容器；同名容器应先移除旧实例（recreate 语义） */
  start(spec: ContainerSpec): Promise<{ id: string }>;
  /** 停止并移除容器（docker rm 语义）；幂等，容器不存在时不抛错 */
  stop(name: string): Promise<void>;
  /** 容器状态；不存在（未创建或已移除）返回 null */
  status(name: string): Promise<ContainerStatus | null>;
  isRunning(name: string): Promise<boolean>;
  /** 容器日志，返回文本；tail 给定时只取最后 N 行 */
  logs(name: string, tail?: number): Promise<string>;
  /**
   * 列出运行中容器（M1 Task 4 新增，"谁是当前运行模型"的判定基础）。
   * label 过滤形如 "key=value"（docker 的 --filter label=key=value 语义），
   * 对应真实实现的 listContainers({ filters: { label: [key=value] } })；
   * 过滤为精确匹配，不带该标签或值不同的容器不返回。
   */
  list(filter?: { label?: string }): Promise<ContainerStatus[]>;
  /**
   * 跟随容器日志，逐行回调 onLine（M3 Task 1：SSE 日志流的行级增量）。
   * ≈ docker logs -f --tail 100：attach 时先补发尾部 100 行再实时跟随。
   * stop() 幂等：销毁底层流并等清理完成；容器不存在（未创建/已移除）不抛错，
   * resolve 一个立即空转的句柄（对齐 logs 的"日志随容器消失"语义）。
   */
  followLogs(name: string, onLine: (line: string) => void): Promise<{ stop(): Promise<void> }>;
}
