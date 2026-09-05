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
  /** 自定义环境变量，原样透传（enable_thinking 等模板层开关已改走 args.ts 的
   *  --chat-template-kwargs CLI 参数，不再需要内置 env 注入） */
  env: z.array(envEntrySchema).optional(),
});

/** 「思考强度」枚举值域：serverConfigSchema（带 default）与 partialServerConfigSchema
 *  （不带，见下方注释）共用，值域字面量只写这一处 */
const reasoningEffortSchema = z.enum(["inherit", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** default 配置 server 段（llama-server 参数集，同 bash 版） */
export const serverConfigSchema = z.object({
  host: z.string().min(1),
  ctx_size: z.number().int().min(0),
  gpu_layers: z.number().int().min(0),
  /**
   * 多卡切分策略（`--split-mode`）。四档取自镜像实测的 help 输出；官方文档已明确
   * `row` 被 `tensor` 取代（本机 RTX 3090 实测 row 直接报 does not support split buffers）。
   *
   * 以下三个字段全部 `.optional()` 且**不给 .default()**：不配就不下发对应 CLI 参数，
   * 保持 llama.cpp 自身默认。给 .default() 会踩下方 reasoning_effort 注释里那个
   * zod 4 的 .partial() 实体化陷阱（该坑已在三处踩过、返工两次）。
   */
  split_mode: z.enum(["none", "layer", "row", "tensor"]).optional(),
  /** 各卡的显存分配比例（`--tensor-split`），逗号分隔，如 `3,1`；顺序是**容器内**卡序 */
  tensor_split: z
    .string()
    .regex(/^\d+(\.\d+)?(,\d+(\.\d+)?)*$/, "tensor_split 必须是逗号分隔的数值，如 3,1")
    .optional(),
  /** 主卡（`--main-gpu`），编号是**容器内**序号而非宿主机 GPU 编号，见 lib/gpu-visibility.ts */
  main_gpu: z.number().int().min(0).optional(),
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
  /**
   * 「思考强度」reasoning_effort：是否生效取决于 chat template 是否读取这个变量
   * （见 lib/reasoning-effort.ts），与模型名无关。`.default("inherit")` 是硬要求、
   * 不能改必填——旧版存量 default_config JSON 不含此键，若必填会让
   * repo/models.ts 的 getDefaultConfig() 在读取存量数据时 safeParse 失败直接抛错
   * （该函数刻意不静默失败），造成所有已保存过默认配置的现有部署一升级就崩。
   *
   * "inherit" 语义 = 跟随模板自身默认，不产出任何 --chat-template-kwargs 的
   * reasoning_effort key。刻意不叫 "default"：llama.cpp 请求侧把字面量
   * "default" 当普通值塞进模板会触发值域校验异常（HTTP 500），不让这个词
   * 进入项目语义，防止将来有人直接透传导致同样的坑。
   */
  reasoning_effort: reasoningEffortSchema.default("inherit"),
});

/**
 * `serverConfigSchema` 的 strict-partial 构造式：模型级 overrides、参数预设
 * （server/repo/presets.ts）、YAML 导出（core/yamlIo.ts）三处都要「部分覆盖 +
 * 拒绝未知键」的同一种 server 段校验，故在这里收敛成一份共享导出。
 *
 * `reasoning_effort` 必须重新声明成不带 default 的裸枚举——zod 4 下 `.partial()`
 * 仍会在字段缺席时把内部 `.default()` 的值实体化进解析结果（已实测确认）。
 * 不处理的话，任何一次局部覆盖（哪怕只改了 gpu_layers）都会悄悄烙上一个用户
 * 从没写过的 `reasoning_effort:"inherit"`——覆盖/预设/导出三处都会中招，
 * 全局默认改了这个字段，被烙过的那份也不再跟随。
 *
 * **新增带 `.default()` 的字段时只需在这里 `.extend()` 一次**——本分支已经因为
 * 这个坑在三处分别踩过、返工过两次，收敛到一处是为了不再有第四次。
 */
export const partialServerConfigSchema = z
  .strictObject(serverConfigSchema.shape)
  .partial()
  .extend({ reasoning_effort: reasoningEffortSchema.optional() });

/**
 * 中转 API 段（「思考强度中转映射」特性）：面板作为 OpenAI 兼容中转入口时的改写行为，
 * 不属于 llama-server 的启动参数集（那是 docker/server 两段的职责），故单开一段。
 *
 * effort_aliases：显式别名表（requested → 目标值），命中时优先于 effort_rounding
 * 的自动取整策略，见 lib/effort-mapping.ts 的判定顺序。
 * effort_rounding："off" 表示不取整、直接丢弃客户端传来的 reasoning_effort 字段，
 * 让模板走自身默认值。
 */
export const apiConfigSchema = z.object({
  effort_aliases: z.record(z.string(), z.string()).default({}),
  effort_rounding: z.enum(["down", "up", "off"]).default("down"),
});

/** default 配置（存 settings.default_config） */
export const defaultConfigSchema = z.object({
  docker: dockerConfigSchema,
  server: serverConfigSchema,
  api: apiConfigSchema.default({ effort_aliases: {}, effort_rounding: "down" }),
});

/** 模型级 overrides：浅合并到 default 上；strict 防止未知键/拼写错误静默丢失 */
export const overridesSchema = z.strictObject({
  docker: z.strictObject(dockerConfigSchema.shape).partial().optional(),
  // strict-partial 构造式（含 reasoning_effort 的 zod 4 .default() 实体化陷阱，
  // 见 partialServerConfigSchema 定义处的注释）收敛在一处，presets.ts / yamlIo.ts
  // 直接 import 同一份，不再各自重写
  server: partialServerConfigSchema.optional(),
  /**
   * api 段整体可选（模型没配就不该有这个键）。两个字段都用 .extend() 重新声明成
   * 不带 default 的裸类型——与上面 reasoning_effort 同源的 zod 4 坑：apiConfigSchema
   * 的两个字段都带 .default()，.partial() 包一层 optional 仍会在字段缺席时把
   * default 值实体化进解析结果（已实测确认）。不处理的话，任何一次局部覆盖
   * （哪怕模型 overrides 里完全不含 api 键）都会让 strictObject(apiConfigSchema.shape)
   * 一旦被间接触发校验就悄悄烙上 {effort_aliases:{}, effort_rounding:"down"}，
   * 从此这个模型不再跟随全局默认的中转策略。
   */
  api: z
    .strictObject(apiConfigSchema.shape)
    .partial()
    .extend({
      effort_aliases: z.record(z.string(), z.string()).optional(),
      effort_rounding: z.enum(["down", "up", "off"]).optional(),
    })
    .optional(),
});

/** GGUF 文件路径：相对 models 根（如 main/qwen.gguf、shared/xxx.gguf），不允许绝对路径 */
export const ggufPathSchema = z.string().regex(
  /^[^/\s:][^:\s]*\.gguf$/,
  "gguf 路径必须是相对 models 根、以 .gguf 结尾的路径",
);

/**
 * 命名空间字符集（阶段 2 B7 前曾以同一字面量复制在 7 处：本文件、四个
 * route 的 body schema、repo/models.ts 与 server/namespaces.ts 各自的模块级
 * 常量——收敛到这一处导出，其余六处改为引用，杜绝"改一处漏一处"）。
 * 首字符限定小写字母/数字：天然排除 `.`、`..`、`.hidden` 三个最危险的形态，
 * 代价几乎为零。不放开大写：SQLite 主键默认 BINARY collation，`Main` 与
 * `main` 会成为两个不同的命名空间，这个坑比放开大写带来的方便贵。
 */
export const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** 命名空间（models 一级目录） */
const namespaceSchema = z
  .string()
  .regex(NAMESPACE_PATTERN, "namespace 只允许小写字母数字、点、下划线与连字符");

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
export type ApiConfig = z.infer<typeof apiConfigSchema>;
export type DefaultConfig = z.infer<typeof defaultConfigSchema>;
export type Overrides = z.infer<typeof overridesSchema>;
export type ModelConfig = z.infer<typeof modelSchema>;
export type PanelConfig = z.infer<typeof panelSchema>;
