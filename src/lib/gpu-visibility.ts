/**
 * 由 `docker.gpu` 推出的容器 GPU 形态（多卡支持批次，设计 §4.1/§4.2/§5.2）
 *
 * `docker.gpu` 有三种形态（core/schemas.ts 的 gpuSchema）：all / none / device=N[,N…]，
 * 其中 device= 里写的是**宿主机**索引，与 nvidia-smi 的 index 同坐标系。
 *
 * ⚠️ 但容器**内**的编号不是这个：NVIDIA Container Toolkit 在部分暴露时会把卡重新从 0
 * 编号，所以 `--main-gpu` / `--tensor-split` 吃的是容器内序号。deviceIndexMap 就是这层
 * 翻译关系，表单据它给用户一行对照说明——不点破的话，配 device=1,2 的用户写 main_gpu=1
 * 会打到宿主机 GPU2 而毫无察觉。
 *
 * 三个函数都是纯函数：解析一次、多处复用，不让 device= 的解析在代码里出现第二份。
 */

const DEVICE_PREFIX = "device=";

/** 注入的设备序环境变量：让 ggml 的枚举顺序与 nvidia-smi 的 PCI 顺序一致 */
export const CUDA_DEVICE_ORDER_ENTRY = "CUDA_DEVICE_ORDER=PCI_BUS_ID";

/**
 * `docker.gpu` → 容器内编号对应的宿主机 GPU 索引数组。
 * 返回 `[1, 2]` 的含义是：容器内 0 号是宿主机 GPU1、容器内 1 号是宿主机 GPU2。
 *
 * "all"（编号一致，无需提示）/ "none" / 任何解析不出的形态一律返回 null——
 * 宁可不提示，也不给出可能是错的对照关系。
 */
export function deviceIndexMap(gpu: string): number[] | null {
  if (!gpu.startsWith(DEVICE_PREFIX)) return null;
  const parts = gpu.slice(DEVICE_PREFIX.length).split(",");
  const indexes: number[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    indexes.push(Number(trimmed));
  }
  return indexes.length > 0 ? indexes : null;
}

/**
 * 分卡明细 → 该 `docker.gpu` 配置下真正可见的卡（宿主机索引坐标系）。
 *
 * 未知形态返回空数组，与 server/adapters/docker-options.ts 把未知形态按 CPU 处理
 * （不设 DeviceRequests）的既有取舍一致：宁可降级也不臆测。
 */
export function visibleDevices<T extends { index: number }>(
  devices: readonly T[],
  gpu: string,
): T[] {
  if (gpu === "all") return [...devices];
  const declared = deviceIndexMap(gpu);
  if (declared === null) return [];
  return devices.filter((device) => declared.includes(device.index));
}

/**
 * 注入的驱动能力集：只要 compute（CUDA 计算）与 utility（nvidia-smi），不要图形栈。
 *
 * 不设时 NVIDIA Container Toolkit 取默认能力集，会为镜像里的图形库建符号链接。
 * llama.cpp 官方镜像带 /usr/lib/x86_64-linux-gnu/gbm/ 目录，**部分暴露 GPU**
 * （--gpus device=N，即面板的多卡挑卡主路径）时该步骤直接失败，容器根本创建不出来：
 *   failed to create link [libnvidia-nvvm.so.4]: bad file descriptor
 * 2026-09-05 双 V100 真机实测：`--gpus all` 不触发（走 CDI 路径），只有 device=N 触发；
 * 加上本项后 device=N 恢复正常。推理不需要 graphics/display，砍掉它们没有副作用。
 */
export const NVIDIA_DRIVER_CAPABILITIES_ENTRY = "NVIDIA_DRIVER_CAPABILITIES=compute,utility";

/** 面板默认注入的 env：[键名, 完整条目]。键名用于判断用户是否已显式写过同名键 */
const DEFAULT_ENV_ENTRIES: readonly (readonly [string, string])[] = [
  ["CUDA_DEVICE_ORDER", CUDA_DEVICE_ORDER_ENTRY],
  ["NVIDIA_DRIVER_CAPABILITIES", NVIDIA_DRIVER_CAPABILITIES_ENTRY],
];

/**
 * 容器 env 组装：用 GPU 时默认注入设备序与驱动能力集两项。
 *
 * CUDA_DEVICE_ORDER=PCI_BUS_ID —— nvidia-smi 默认按 PCI bus 排序，CUDA runtime 默认
 * FASTEST_FIRST（按算力排），ggml 用 cudaGetDeviceCount 直接枚举且不设置该变量。
 * 同构多卡两种排序一致；异构多卡（如 4090 + 3090）会错位——面板显示的「GPU 0」与
 * llama.cpp 的「CUDA0」不是同一张卡。注入后与 nvidia-smi 对齐。
 *
 * NVIDIA_DRIVER_CAPABILITIES —— 理由见该常量注释，缺了会让 device=N 挑卡直接起不来。
 *
 * 两项都遵循同一条规则：**用户自己写过同名键就不插手那一项**（另一项照常注入），
 * 显式配置永远优先于面板的默认注入。判断用 `键名=` 前缀，避免
 * NVIDIA_DRIVER_CAPABILITIES_EXTRA 这类相近键被误判成命中。
 *
 * gpu="none" 时两项都不注入——纯 CPU 容器里它们是死配置，只会让读 docker inspect 的人困惑。
 */
export function buildContainerEnv(
  userEnv: readonly string[],
  gpu: string,
): string[] | undefined {
  if (gpu === "none") return userEnv.length > 0 ? [...userEnv] : undefined;
  const injected = DEFAULT_ENV_ENTRIES.filter(
    ([key]) => !userEnv.some((entry) => entry.startsWith(`${key}=`)),
  ).map(([, entry]) => entry);
  return [...injected, ...userEnv];
}
