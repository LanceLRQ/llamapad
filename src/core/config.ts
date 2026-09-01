import { overridesSchema, type DefaultConfig, type Overrides } from "./schemas";

/**
 * 配置域纯函数（M0 Task 5）
 *
 * - mergeConfig：模型级 overrides 浅合并到默认配置上（两层 section、禁止整段替换）
 * - effectiveParams：合并结果拍平为 "docker.xxx"/"server.xxx" 扁平键值，
 *   供模型编辑页预览与 Docker 适配器共用同一形态
 * - BUILTIN_DEFAULT_CONFIG：settings.default_config 未设置时的内置默认
 *
 * 校验取舍：对 overrides 先 overridesSchema.safeParse，失败抛普通 Error，
 * message 自行拼接 issue 的 path.join(".") + message（zod 4）——
 * 调用方（repo / API 层 / 组件）无需 import zod 或特判 ZodError，错误契约统一，
 * 且保证 "段.字段" 精确出现在 message 中（z.prettifyError 的输出格式由 zod 控制，
 * 不适合被正则断言）。未直接 .parse() 透传 ZodError 是为了避免它在调用链中
 * 被层层包装后丢失路径信息。
 */

/** 内置默认配置：bash 前身（llama-launcher）默认参数 + 设计文档修正后的 docker 段 */
export const BUILTIN_DEFAULT_CONFIG: DefaultConfig = {
  docker: {
    image: "ghcr.io/ggml-org/llama.cpp:server-cuda",
    container_name: "llama-server",
    model_volume: "/srv/llama/models:/models",
    host_port: 18080,
    container_port: 8080,
    gpu: "all",
  },
  server: {
    host: "0.0.0.0",
    ctx_size: 131072,
    gpu_layers: 99,
    flash_attention: "on",
    batch_size: 4096,
    ubatch_size: 1024,
    cont_batching: true,
    cache_type_k: "q4_0",
    cache_type_v: "q4_0",
    enable_thinking: false,
    repeat_penalty: 1.0,
    presence_penalty: 1.5,
    min_p: 0.0,
    top_k: 20,
    top_p: 0.8,
    temp: 0.7,
    reasoning_effort: "inherit",
  },
};

/** 校验 overrides；失败抛 message 含字段路径（段.字段）的 Error */
function validateOverrides(overrides: Overrides): Overrides {
  const result = overridesSchema.safeParse(overrides);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`overrides 校验失败: ${detail}`);
  }
  return result.data;
}

/**
 * 模型级 overrides 合并到默认配置：两段各自浅合并（spread），
 * 既不允许整段替换（未给的键保留默认），也保证返回值与 defaults 不共享引用
 * （两层结构内无更深嵌套，两层浅拷贝即满足深拷贝）。
 */
export function mergeConfig(defaults: DefaultConfig, overrides: Overrides): DefaultConfig {
  const validated = validateOverrides(overrides);
  return {
    docker: { ...defaults.docker, ...validated.docker },
    server: { ...defaults.server, ...validated.server },
  };
}

/**
 * 合并后拍平为扁平参数表：键为 "段名.字段名"（如 "server.gpu_layers"）。
 * 默认场景（未设自定义镜像逃生口字段）共 23 键（docker 6 + server 17），
 * 值类型仅 string | number | boolean。
 *
 * 自定义镜像的数组字段（entrypoint/extra_args/args_override/env，§5.6）不参与
 * 本表：它们的形态与标量字段不同，展示这类字段是专门的自定义镜像区块的职责，
 * 不是本函数（模型编辑页参数预览）的职责——跳过而非报错，保持函数对"未设置
 * 这些字段"的默认场景零影响。
 */
export function effectiveParams(
  defaults: DefaultConfig,
  overrides: Overrides,
): Record<string, string | number | boolean> {
  const merged = mergeConfig(defaults, overrides);
  const params: Record<string, string | number | boolean> = {};
  for (const section of ["docker", "server"] as const) {
    for (const [key, value] of Object.entries(merged[section])) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        params[`${section}.${key}`] = value;
      }
    }
  }
  return params;
}
