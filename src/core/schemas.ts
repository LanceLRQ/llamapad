import { z } from "zod";

/**
 * 配置 Schema（M0 Task 4）
 *
 * 依据 docs/_internal/design/2026-08-24-需求分析与整体设计.md §5：
 * - default 配置（settings.default_config）：docker + server 两段，字段集 = bash 版 ∪ 设计文档修正
 *   （修正 1：GPU 字段名用 `gpu`，修正 bash 版 gpu_devices 不生效问题；
 *    修正 2：model_volume 以宿主机视角书写；bash 版独有的 container_port 并集保留）
 * - 模型级 overrides：两层浅 Partial，strict 拒绝未知键（防拼写错误静默丢失）
 * - panel.yaml（基础设施，文件形态）：paths.models 路径映射 + 可选 proxy + listen
 *
 * zod 4 API 注意：URL 用 z.url()；对象缺省填充用 .prefault()（会解析默认值，
 * 而 .default() 原样返回不解析）；strict 对象用 z.strictObject()。
 */

/** GPU 选择：all | none | device=N[,N…]（设计文档 §5.1 修正后的语义） */
export const gpuSchema = z.union([
  z.literal("all"),
  z.literal("none"),
  z.string().regex(/^device=\d+(,\d+)*$/, "gpu 必须是 all / none / device=N[,N…]"),
]);

/** KV cache 量化类型（llama.cpp 支持的常用子集） */
export const cacheTypeSchema = z.enum([
  "f16",
  "q8_0",
  "q4_0",
  "q4_k",
  "q5_0",
  "q5_k",
  "q6_k",
  "q8_k",
]);

/** sha256 摘要：64 位小写 hex，可选用于下载完成后校验（§8） */
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "sha256 必须是 64 位小写 hex");

/** 模型下载来源：HF 仓库或 URL 直链（§8；ModelScope 为 Non-goal） */
export const downloadSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("hf"),
    repo: z.string().min(1),
    file: z.string().min(1),
    sha256: sha256Schema.optional(),
  }),
  z.object({
    source: z.literal("url"),
    url: z.url(),
    file: z.string().min(1),
    sha256: sha256Schema.optional(),
  }),
]);

/** Docker 容器名（Docker 命名规则） */
const containerNameSchema = z.string().regex(
  /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/,
  "container_name 必须以字母或数字开头，仅含字母数字_.-",
);

/** bind mount 卷：/host:/container，两侧为非空无空白路径（如 ./models:/models） */
const modelVolumeSchema = z.string().regex(
  /^[^:\s]+:[^:\s]+$/,
  "model_volume 必须形如 /host:/container",
);

/** TCP 端口 */
const portSchema = z.number().int().min(1).max(65535);

/** default 配置 docker 段（字段必填：default 配置应完整可引导） */
export const dockerConfigSchema = z.object({
  image: z.string().min(1),
  container_name: containerNameSchema,
  model_volume: modelVolumeSchema,
  host_port: portSchema,
  container_port: portSchema,
  gpu: gpuSchema,
});

/** default 配置 server 段（llama-server 参数集，同 bash 版） */
export const serverConfigSchema = z.object({
  host: z.string().min(1),
  ctx_size: z.number().int().min(0),
  gpu_layers: z.number().int().min(0),
  flash_attention: z.enum(["on", "off"]),
  batch_size: z.number().int().min(1),
  ubatch_size: z.number().int().min(1),
  cont_batching: z.boolean(),
  cache_type_k: cacheTypeSchema,
  cache_type_v: cacheTypeSchema,
  enable_thinking: z.boolean(),
  repeat_penalty: z.number().min(0).max(2),
  presence_penalty: z.number().min(-2).max(2),
  min_p: z.number().min(0).max(1),
  top_k: z.number().int().min(0),
  top_p: z.number().min(0).max(1),
  temp: z.number().min(0).max(2),
});

/** default 配置（存 settings.default_config） */
export const defaultConfigSchema = z.object({
  docker: dockerConfigSchema,
  server: serverConfigSchema,
});

/** 模型级 overrides：浅合并到 default 上；strict 防止未知键/拼写错误静默丢失 */
export const overridesSchema = z.strictObject({
  docker: z.strictObject(dockerConfigSchema.shape).partial().optional(),
  server: z.strictObject(serverConfigSchema.shape).partial().optional(),
});

/** GGUF 文件路径：相对 models 根（如 main/qwen.gguf、shared/xxx.gguf），不允许绝对路径 */
const ggufPathSchema = z.string().regex(
  /^[^/\s:][^:\s]*\.gguf$/,
  "gguf 路径必须是相对 models 根、以 .gguf 结尾的路径",
);

/** 命名空间（models 一级目录） */
const namespaceSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "namespace 只允许小写字母数字与连字符");

/** 模型配置（models 表对应结构，§5.2） */
export const modelSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "name 只允许小写字母数字与连字符"),
  display_name: z.string().min(1),
  namespace: namespaceSchema.default("main"),
  gguf_file: ggufPathSchema,
  mmproj_file: ggufPathSchema.optional(),
  download: downloadSchema.optional(),
  overrides: overridesSchema.prefault({}),
});

/** panel.yaml（基础设施配置，文件形态，§5.1；paths/listen 缺省按约定目录推断） */
export const panelSchema = z.object({
  paths: z
    .object({
      models: z
        .object({
          host: z.string().min(1).default("/srv/llama/models"),
          panel: z.string().min(1).default("/srv/llama/models"),
        })
        .prefault({}),
    })
    .prefault({}),
  proxy: z.url().optional(),
  listen: z
    .object({
      host: z.string().min(1).default("0.0.0.0"),
      port: portSchema.default(8080),
    })
    .prefault({}),
});

// ---------- TS 类型 ----------

export type Gpu = z.infer<typeof gpuSchema>;
export type CacheType = z.infer<typeof cacheTypeSchema>;
export type DownloadConfig = z.infer<typeof downloadSchema>;
export type DockerConfig = z.infer<typeof dockerConfigSchema>;
export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type DefaultConfig = z.infer<typeof defaultConfigSchema>;
export type Overrides = z.infer<typeof overridesSchema>;
export type ModelConfig = z.infer<typeof modelSchema>;
export type PanelConfig = z.infer<typeof panelSchema>;
