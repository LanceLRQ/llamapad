import type dockerode from "dockerode";
import type { ContainerSpec } from "./types";

/**
 * dockerode createContainer 选项构建（M1 Task 4，纯函数无 IO）
 *
 * 把 ContainerSpec 翻译为 dockerode 的 ContainerCreateOptions，供 real 适配器
 * （M1 后续任务）调用 docker.createContainer(buildCreateOptions(spec))。
 *
 * name 的传递方式：dockerode 的 createContainer 只接受单个 options 对象，
 * 容器名是其上的 name 字段（dockerode 内部转 ?name= 查询参数），并非
 * createContainer(config, name) 的第二参数——以 @types/dockerode 4.0.1 为准。
 *
 * GPU 三形态（"all" / "none" / "device=N[,M…]"）映射到 HostConfig.DeviceRequests：
 * - "all"  → [{ Driver: "", Count: -1, Capabilities: [["gpu"]] }]（--gpus all）
 * - "none" → 不设 DeviceRequests 键（纯 CPU）
 * - "device=N,…" → [{ Driver: "", DeviceIDs: ["N", …], Capabilities: [["gpu"]] }]（--gpus "device=N,M"）
 *
 * ⚠ GPU 三形态在 Mac Docker Desktop 上无法真机验证（不支持 --gpus），
 * correctness 由 docker-options.test.ts 单测锚定，真机验证留 M4。
 */

/** GPU 字符串 → HostConfig.DeviceRequests；"none" 返回 undefined（不设键） */
function deviceRequests(gpu: string): dockerode.DeviceRequest[] | undefined {
  if (gpu === "none") return undefined;
  if (gpu === "all") {
    return [{ Driver: "", Count: -1, Capabilities: [["gpu"]] }];
  }
  // "device=N[,N…]"：逗号分隔的设备序号
  if (gpu.startsWith("device=")) {
    const deviceIds = gpu
      .slice("device=".length)
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    return [{ Driver: "", DeviceIDs: deviceIds, Capabilities: [["gpu"]] }];
  }
  // 未知形态按 CPU 处理（不设键），宁可降级也不构造非法 DeviceRequests
  return undefined;
}

/** ContainerSpec → dockerode ContainerCreateOptions */
export function buildCreateOptions(spec: ContainerSpec): dockerode.ContainerCreateOptions {
  const portKey = `${spec.containerPort}/tcp`;
  const hostConfig: dockerode.HostConfig = {
    PortBindings: { [portKey]: [{ HostPort: String(spec.hostPort) }] },
    Binds: [spec.volume],
    AutoRemove: true, // --rm 语义：容器停止即自动移除
  };
  // "none"（及未知形态）不设 DeviceRequests 键（纯 CPU）
  const requests = deviceRequests(spec.gpu);
  if (requests !== undefined) {
    hostConfig.DeviceRequests = requests;
  }
  const options: dockerode.ContainerCreateOptions = {
    name: spec.name,
    Image: spec.image,
    Cmd: spec.args,
    Labels: spec.labels,
    Tty: false,
    Env: spec.env ?? [],
    ExposedPorts: { [portKey]: {} },
    HostConfig: hostConfig,
  };
  // 自定义镜像逃生口（§5.6）：只在显式覆盖时才设置 Entrypoint 键。
  // dockerode/Docker API 把"键不存在"（沿用镜像自身 entrypoint）与"显式设为
  // 空数组"视为两种不同语义，不能像 Env 那样兜底成 []——那会让所有未自定义
  // entrypoint 的模型都启动失败（镜像默认 entrypoint 被清空）
  if (spec.entrypoint !== undefined) {
    options.Entrypoint = spec.entrypoint;
  }
  return options;
}
