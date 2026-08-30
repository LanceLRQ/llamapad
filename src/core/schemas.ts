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

/** 自定义镜像逃生口（§5.6）的数组字段：只做基本形态校验（元素非空），
 *  不校验语义——用户配错自负是明确的产品决策（决策 6） */
const nonEmptyStringArraySchema = z.array(z.string().min(1, "数组元素不能为空"));

/** 环境变量条目：KEY=value（KEY 取常见 shell 变量名约定，value 允许为空串） */
const envEntrySchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*=.*$/, "env 元素必须形如 KEY=value");

/** default 配置 docker 段（字段必填：default 配置应完整可引导） */
export const dockerConfigSchema = z.object({
  image: z.string().min(1),
  container_name: containerNameSchema,
  model_volume: modelVolumeSchema,
  host_port: portSchema,
  container_port: portSchema,
  gpu: gpuSchema,
  /**
   * 容器内模型挂载点（自定义镜像逃生口，§5.6，同时修掉 §1.2 的现存缺陷：
   * model_volume 可被覆盖到任意路径，但 runtime.ts 曾把 -m 参数写死 /models/，
   * 两者一旦不一致启动必失败）。
   *
   * 不设 z.default()：本 schema 的 shape 同时喂给 overridesSchema
   * （z.strictObject(dockerConfigSchema.shape).partial()）；zod 4 下
   * .partial() 包一层 optional 仍会在字段缺席时把内部 default 的值实体化进
   * 解析结果（已用最小复现验证），那会让任何一次局部 docker 覆盖（哪怕只改
   * host_port）都悄悄在该模型 overrides 里烙上 model_mount:"/models"——往后
   * 全局默认改了这个模型也不再跟随。留空交运行时兜底（见 runtime.ts
   * buildContainerSpec），overrides 就只在用户真的写了这个键时才携带它。
   */
  model_mount: z.string().min(1, "model_mount 不能为空").optional(),
  /** 覆盖镜像 entrypoint；未设置时用镜像自身默认 entrypoint */
  entrypoint: nonEmptyStringArraySchema.optional(),
  /** 追加在生成参数之后（与 args_override 二选一，见 runtime.ts buildContainerSpec） */
  extra_args: nonEmptyStringArraySchema.optional(),
  /** 整体取代生成参数；三个占位符（model_path/mmproj_path/port）的替换规则见 core/images.ts */
  args_override: nonEmptyStringArraySchema.optional(),
  /** 自定义环境变量，与内置 LLAMA_CHAT_TEMPLATE_KWARGS 合并，用户值在后（可覆盖同名变量） */
  env: z.array(envEntrySchema).optional(),
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
export const ggufPathSchema = z.string().regex(
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
          // 无默认值：留空才能与"写了"区分开，是 getModelsHost 优先级链的前提
          // （env > panel.yaml > 自动发现 > 未解析），写死默认会让"没配"和"配错"
          // 两种状态在这里就分不清
          host: z.string().min(1).optional(),
          // compose 的固定约定：面板容器一律把宿主机 models 目录挂到这个路径
          panel: z.string().min(1).default("/host-models"),
        })
        .prefault({}),
    })
    .prefault({}),
  proxy: z.url().optional(),
  /** 页头「打开 llama UI」外链按钮的目标地址（§挂账②）：留空按浏览器地址推导
   *  http://<hostname>:<host_port>；只影响这个外链按钮，不影响 Chat 页本身——
   *  Chat 页走面板自己的同源反代，单域名/HTTPS 均可直接用。这个按钮是新标签页
   *  导航，不受 mixed content 限制，仅当目标域启用了 HSTS、导致浏览器把这个
   *  明文地址强升为 https 而连接失败时，才需要在此显式指定一个可达地址 */
  chat: z
    .object({ base_url: z.url().optional() })
    .prefault({}),
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
