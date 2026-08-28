/**
 * 镜像管理纯逻辑（M5 镜像管理，规格 docs/_internal/features/2026-08-28-文件管理与镜像管理-design.md §5.2/§5.3/§5.6）
 *
 * 本文件不含 IO：官方 variant 清单是硬编码常量（不做 tag 在线枚举，理由见 §5.2——
 * ghcr 匿名 token 分页拿一堆历史 build 号是纯噪音）；平台推荐与占位符替换均为
 * 输入确定、输出确定的纯函数，nvidia-smi 的实际调用与请求聚合留给 route 层。
 */

/** 官方 llama.cpp 镜像仓库（不含 tag） */
export const LLAMA_REGISTRY = "ghcr.io/ggml-org/llama.cpp";

/**
 * 官方 server variant 固定清单（§5.2）：9 个 tag 的存在性已实测确认（匿名 token
 * 查 manifest 全部 200，编造的 tag 返回 404）。只收 server-*——面板只跑
 * llama-server，`full`/`light` 与本产品无关。版本策略只跟 rolling tag（等价
 * "最新"），不做版本回退（决策 5）。
 */
export const SERVER_VARIANTS = [
  { tag: "server", platform: "cpu" },
  { tag: "server-cuda", platform: "cuda12" },
  { tag: "server-cuda13", platform: "cuda13" },
  { tag: "server-rocm", platform: "rocm" },
  { tag: "server-musa", platform: "musa" },
  { tag: "server-intel", platform: "intel" },
  { tag: "server-vulkan", platform: "vulkan" },
  { tag: "server-openvino", platform: "openvino" },
  { tag: "server-s390x", platform: "s390x" },
] as const;

export type ServerVariantTag = (typeof SERVER_VARIANTS)[number]["tag"];

/**
 * GPU 版本信息：从 nvidia-smi 头部输出解析得到，或调用方直接给出已知值。
 * 两字段独立可选——CUDA Version 行拿不到时，driver_version 仍可能可用。
 */
export interface GpuVersionInfo {
  /** CUDA 版本，如 "13.2"（nvidia-smi 头部 "CUDA Version: X.Y"） */
  cudaVersion?: string;
  /** 驱动版本，如 "595.71.05"（nvidia-smi 头部 "Driver Version: X.Y.Z"） */
  driverVersion?: string;
}

/**
 * 从 nvidia-smi 原始输出（不带 --query-gpu 的默认表格形态）解析头部版本行。
 * 拿不到的字段保持 undefined，不抛错——调用方（recommendServerVariant）据此
 * 决定是否需要 driver_version 回退。
 */
export function parseGpuVersionInfo(output: string): GpuVersionInfo {
  const cuda = output.match(/CUDA Version:\s*([\d.]+)/);
  const driver = output.match(/Driver Version:\s*([\d.]+)/);
  return {
    cudaVersion: cuda?.[1],
    driverVersion: driver?.[1],
  };
}

/**
 * 官方 server variant 的平台推荐（§5.3，纯函数）。
 *
 * 输入三选一：nvidia-smi 原始输出文本、已解析的 GpuVersionInfo、或 null
 * （无 GPU / 无 nvidia-smi，探测阶段已确认不可用）。
 *
 * 判定顺序：
 * 1. CUDA Version 能解析 → X>=13 推荐 cuda13，12<=X<13 推荐 cuda12，
 *    X<12（很旧但仍解析成功）直接给纯 CPU，不再退回 driver 阈值——
 *    "解析不到" 专指正则没命中，不含"命中但数值太旧"
 * 2. CUDA Version 整行解析不到 → 退回 driver_version 阈值：>=580 → cuda13，
 *    >=525 → cuda12
 * 3. 都拿不到 → 推荐纯 CPU（"server"）
 *
 * ROCm/MUSA/Intel/OpenVINO/s390x 在面板容器内无从探测，不参与本函数推荐，
 * 清单里照常列出（由调用方标注"需自行确认硬件支持"）。
 *
 * 推荐只影响排序与标记，不锁定选择——任何 variant 用户都能选（决策 5）。
 */
export function recommendServerVariant(input: string | GpuVersionInfo | null): ServerVariantTag {
  if (input === null) return "server";
  const info = typeof input === "string" ? parseGpuVersionInfo(input) : input;

  if (info.cudaVersion !== undefined) {
    const major = Number.parseInt(info.cudaVersion, 10);
    if (major >= 13) return "server-cuda13";
    if (major >= 12) return "server-cuda";
    return "server";
  }

  if (info.driverVersion !== undefined) {
    const driverMajor = Number.parseFloat(info.driverVersion);
    if (driverMajor >= 580) return "server-cuda13";
    if (driverMajor >= 525) return "server-cuda";
  }
  return "server";
}

/** applyArgsOverridePlaceholders 的占位符取值（§5.6） */
export interface ArgsOverridePlaceholders {
  /** {{model_path}} 的替换值：`<model_mount>/<ggufRel>` */
  modelPath: string;
  /** {{mmproj_path}} 的替换值；模型未配置 mmproj 时为 undefined（替换为空串） */
  mmprojPath?: string;
  /** {{port}} 的替换值：docker.container_port */
  port: number;
}

/**
 * args_override 的占位符替换（§5.6，仅此三个占位符，不构成模板引擎）：
 * 逐个数组元素做字符串替换；某元素替换后为空串则整项丢弃——未配置 mmproj 时
 * "{{mmproj_path}}" 单独一项会变成空串被丢弃，但紧邻的 "--mmproj" 仍会保留
 * （悬空标志），这类成对写法需用户自行保证（方案 A 的既定取舍，见 §5.6）。
 */
export function applyArgsOverridePlaceholders(
  argsOverride: readonly string[],
  placeholders: ArgsOverridePlaceholders,
): string[] {
  const replacements: readonly [string, string][] = [
    ["{{model_path}}", placeholders.modelPath],
    ["{{mmproj_path}}", placeholders.mmprojPath ?? ""],
    ["{{port}}", String(placeholders.port)],
  ];

  const result: string[] = [];
  for (const raw of argsOverride) {
    let value = raw;
    for (const [placeholder, replacement] of replacements) {
      value = value.split(placeholder).join(replacement);
    }
    if (value === "") continue;
    result.push(value);
  }
  return result;
}
