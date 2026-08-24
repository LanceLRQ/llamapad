import type { ServerConfig } from "./schemas";

/**
 * llama-server CLI 参数构建（M0 Task 6，纯函数无 IO）
 *
 * 参数映射的权威来源：bash 前身 llama-launcher/model-manager.sh L396-418
 * （docker run 尾部的 llama-server 参数表）。逐字段对照：
 *
 * | 配置字段           | llama-server 参数        | bash 版写法（行号）            |
 * |--------------------|--------------------------|--------------------------------|
 * | （模型文件）       | -m /models/…gguf         | -m "${model_path}"（L401）     |
 * | server.host        | --host <v>               | --host "${host}"（L402）       |
 * | （容器端口）       | --port <v>               | 未传（见下）                   |
 * | server.ctx_size    | --ctx-size <n>           | L403                           |
 * | server.gpu_layers  | --gpu-layers <n>         | L404                           |
 * | server.flash_attention | --flash-attn on/off  | --flash-attn "${fa}"（L405，值形式） |
 * | server.batch_size  | --batch-size <n>         | L406                           |
 * | server.ubatch_size | --ubatch-size <n>        | L407                           |
 * | server.cache_type_k| --cache-type-k <t>       | -ctk（L361-363，等价短格式）   |
 * | server.cache_type_v| --cache-type-v <t>       | -ctv（L364-366，等价短格式）   |
 * | server.cont_batching   | --cont-batching      | true 时纯开关（L350-352）      |
 * | （mmproj 文件）    | --mmproj /models/…gguf   | 有值才加（L366-368）           |
 * | server.enable_thinking | --reasoning-format none | 见下（bash 走 docker env）   |
 * | server.repeat_penalty      | --repeat-penalty <n> | L413                    |
 * | server.presence_penalty    | --presence-penalty <n> | L414                  |
 * | server.min_p       | --min-p <n>              | L415                           |
 * | server.top_k       | --top-k <n>              | L416                           |
 * | server.top_p       | --top-p <n>              | L417                           |
 * | server.temp        | --temp <n>               | L418                           |
 *
 * 与 bash 版的刻意差异（两项，均为任务规格要求）：
 * 1. cache 类型用等价长格式 --cache-type-k/--cache-type-v（bash 用短格式
 *    -ctk/-ctv，llama.cpp 中两者完全等价）。
 * 2. 显式传 --port <容器端口>：bash 版从未给 llama-server 传端口，隐式依赖
 *    镜像默认 8080（其 container_port 配置形同虚设）；此处把 docker.container_port
 *    真正传给 server，使"改容器端口"可用。
 *
 * enable_thinking 的处理依据：bash 版不是把它映射为 server 参数，而是经
 * docker 环境变量注入（L396：-e LLAMA_CHAT_TEMPLATE_KWARGS='{"enable_thinking":…}'）。
 * 环境变量无法进入本函数产出的 args 数组，故按 llama.cpp server 当前 CLI 的
 * 合理等价映射（任务规格约定）：
 *   enable_thinking=false → --reasoning-format none（关闭思考输出解析）
 *   enable_thinking=true  → 不加参数（默认格式，思考内容正常输出）
 */

/** buildArgs 输入 */
export interface BuildArgsInput {
  /** 合并后的 server 段配置（default ⊕ overrides） */
  server: ServerConfig;
  /** 模型 gguf 的容器内路径（如 /models/main/qwen3.5.gguf） */
  modelPath: string;
  /** 多模态投影文件的容器内路径；无则不传 --mmproj */
  mmprojPath?: string;
  /** 容器内端口（docker.container_port） */
  port: number;
}

/**
 * 构建 llama-server CLI 参数（不含 "llama-server" 程序名本身）。
 * 顺序沿用 bash 版参数表（-m → host/port → 性能参数 → 开关 → 采样参数），
 * --port 插在 --host 之后；输出为 string[]，数值一律 String() 化。
 */
export function buildArgs(input: BuildArgsInput): string[] {
  const { server, modelPath, mmprojPath, port } = input;

  const args: string[] = [
    "-m",
    modelPath,
    "--host",
    server.host,
    "--port",
    String(port),
    "--ctx-size",
    String(server.ctx_size),
    "--gpu-layers",
    String(server.gpu_layers),
    // bash 版为值形式（--flash-attn on/off），原样透传枚举
    "--flash-attn",
    server.flash_attention,
    "--batch-size",
    String(server.batch_size),
    "--ubatch-size",
    String(server.ubatch_size),
    "--cache-type-k",
    server.cache_type_k,
    "--cache-type-v",
    server.cache_type_v,
  ];

  // 纯开关：true 才产出，false 不产出（bash L350-352 同）
  if (server.cont_batching) {
    args.push("--cont-batching");
  }

  if (mmprojPath !== undefined) {
    args.push("--mmproj", mmprojPath);
  }

  // enable_thinking=false 的 CLI 等价（见文件头注释）；true 走默认，不加参数
  if (!server.enable_thinking) {
    args.push("--reasoning-format", "none");
  }

  args.push(
    "--repeat-penalty",
    String(server.repeat_penalty),
    "--presence-penalty",
    String(server.presence_penalty),
    "--min-p",
    String(server.min_p),
    "--top-k",
    String(server.top_k),
    "--top-p",
    String(server.top_p),
    "--temp",
    String(server.temp),
  );

  return args;
}
