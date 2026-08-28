import type { PullFrame } from "../../core/pull-progress";

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
  /** 容器环境变量（"KEY=value" 形态），如 enable_thinking 的模板层开关
   *  LLAMA_CHAT_TEMPLATE_KWARGS（M4 真机定案，bash launcher 同款机制） */
  env?: string[];
  /** llama-server 完整 CLI 参数（由 core/args.ts 的 buildArgs 产出，不含程序名） */
  args: string[];
  /** 覆盖镜像 entrypoint（自定义镜像逃生口，§5.6）；未设置时用镜像自身默认
   *  entrypoint——docker-options.ts 据此区分"不设置该键"与"显式设为空"两种
   *  语义，不能像 env 那样兜底成空数组 */
  entrypoint?: string[];
}

/** 本地镜像信息（M5 镜像管理，规格 §5.4） */
export interface ImageInfo {
  /** 镜像 ID（含 sha256: 前缀，docker images/inspect 原生格式） */
  id: string;
  /** 该镜像的全部 tag（形如 "ghcr.io/ggml-org/llama.cpp:server-cuda"）；未打 tag 为空数组 */
  tags: string[];
  /** 镜像体积（字节） */
  size: number;
  /** 拉取/创建时间（ISO 8601） */
  created: string;
}

/** 容器挂载项（docker inspect 的 Mounts 子集） */
export interface ContainerMount {
  /** "bind" | "volume" | "tmpfs" 等 */
  type: string;
  /** 宿主机侧路径（bind 时有意义；volume 时是卷名或卷目录） */
  source: string;
  /** 容器内路径 */
  destination: string;
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
 * 容器资源用量单帧快照（M3 Task 2 指标采集）。
 * ≈ docker stats --no-stream 的一帧：CPU% 由 (cpuΔ/systemΔ)×online_cpus×100
 * 得出（docker stats CLI 同款公式），内存/网络为绝对值。
 */
export interface ContainerStatsSample {
  /** CPU 占用率，clamp 到 0 ~ cpuCount×100（16 核满载 = 1600） */
  cpuPercent: number;
  /** 在线 CPU 核数（online_cpus；daemon 缺省时回退 percpu_usage 长度，再回退 1） */
  cpuCount: number;
  /** 内存用量字节（memory_stats.usage；缺失 → 0） */
  memBytes: number;
  /** 内存上限字节（memory_stats.limit） */
  memLimitBytes: number;
  /** 网络接收字节（networks 各接口 rx_bytes 求和；无网络命名空间 → 0） */
  netRxBytes: number;
  /** 网络发送字节（networks 各接口 tx_bytes 求和） */
  netTxBytes: number;
  /** 采样时间戳（毫秒） */
  ts: number;
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
   * 容器资源用量单帧（M3 Task 2；≈ docker stats --no-stream）。
   * 容器不存在 / 未运行返回 null。
   */
  stats(name: string): Promise<ContainerStatsSample | null>;
  /**
   * 跟随容器日志，逐行回调 onLine（M3 Task 1：SSE 日志流的行级增量）。
   * ≈ docker logs -f --tail 100：attach 时先补发尾部 100 行再实时跟随。
   * stop() 幂等：销毁底层流并等清理完成；容器不存在（未创建/已移除）不抛错，
   * resolve 一个立即空转的句柄（对齐 logs 的"日志随容器消失"语义）。
   */
  followLogs(name: string, onLine: (line: string) => void): Promise<{ stop(): Promise<void> }>;
  /**
   * 跟随容器资源用量的秒级流（秒级指标采集 代号 B）：docker stats
   * `?stream=true` 逐帧回调 onSample，形态对齐 followLogs。首帧
   * `precpu_stats` 为空、CPU% 算不出，实现方应跳过首帧不产样本。
   * 仅供"最新一帧快照"使用——不进时序 ring，历史曲线链路不依赖它。
   * 容器不存在（404）→ 静默空句柄（同 followLogs）；stop() 幂等。
   */
  followStats(
    name: string,
    onSample: (sample: ContainerStatsSample) => void,
  ): Promise<{ stop(): Promise<void> }>;
  /**
   * 拉取镜像（U14）。onProgress 收到 dockerode followProgress 的原始帧，
   * 聚合由调用方（core/pull-progress）负责——适配层只做搬运不做解释。
   * 镜像不存在 / 认证失败等错误上抛（含 docker 返回的原始 message）。
   *
   * signal 给定时用于中止（§5.5）：中止后销毁本地正在读取的 pull 流，
   * 让 Promise 尽快以错误结束——Docker Engine API 没有"取消 pull"端点，
   * 客户端断流后 daemon 端是否真正停止下载不保证，本方法只负责"面板这端
   * 不再等待/不再消耗这条连接"。
   */
  pullImage(image: string, onProgress?: (frame: PullFrame) => void, signal?: AbortSignal): Promise<void>;
  /** 查容器挂载表；容器不存在返回 null，其余错误上抛 */
  inspectMounts(nameOrId: string): Promise<ContainerMount[] | null>;
  /** 本地镜像列表（M5 镜像管理 §5.4） */
  listImages(): Promise<ImageInfo[]>;
  /**
   * 删除本地镜像（ref 可为 tag 或 id）。被运行中容器占用时 docker 自身拒绝
   * （409），错误原样上抛，不在适配层吞掉或转译；force 透传 docker 的强制删除。
   */
  removeImage(ref: string, force?: boolean): Promise<void>;
}
