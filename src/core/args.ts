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
 * | server.enable_thinking | --chat-template-kwargs {"enable_thinking":…} | 见下（bash 走 docker env） |
 * | server.reasoning_effort | --chat-template-kwargs {"reasoning_effort":…}（inherit 时不产出该 key） | 无对应（新增字段） |
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
 * enable_thinking 的处理依据：bash 版经 docker 环境变量注入
 * （L396：-e LLAMA_CHAT_TEMPLATE_KWARGS='{"enable_thinking":…}'），本项目 M4
 * 真机联调时也曾原样沿用该 env 通道（见 runtime.ts 历史版本）。此后上游
 * llama.cpp 把这个环境变量改名为 LLAMA_ARG_CHAT_TEMPLATE_KWARGS（加了
 * LLAMA_ARG_ 前缀），旧名在新版镜像上完全失效（实测：旧名思考仍开启，新名
 * 才生效）。修复改走 CLI 参数 --chat-template-kwargs——该参数新旧版本
 * llama.cpp 都支持（实测 b8173 与 build 10450 均可），一次性摆脱 env 改名
 * 问题：
 *   --chat-template-kwargs '{"enable_thinking":<bool>}'
 * 取值用 JSON.stringify 生成；args 数组直接交给 dockerode（exec 形式不经
 * shell），JSON 串作为单个 argv 元素即可，不需要外层引号或 shell 转义。
 *
 * reasoning_effort（「思考强度」）复用同一个参数：合并进同一个 chatTemplateKwargs
 * 对象，与 enable_thinking 一起产出一份 --chat-template-kwargs（已实测 llama.cpp
 * 支持一个参数带多个 key）。"inherit"（跟随模板自身默认）时不写入该 key——
 * 是否支持这个变量、允许哪些值完全取决于 chat template 是否读取/校验它，与模型名
 * 无关，前置校验见 lib/reasoning-effort.ts；这里只负责按已校验过的值原样透传。
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

  // 无条件：面板推理指标曾依赖 /metrics prometheus 端点（M4 定案）；
  // M5 改采 /slots 后面板自身已不消费，保留暴露作为可直连的诊断端点
  args.push("--metrics");

  if (mmprojPath !== undefined) {
    args.push("--mmproj", mmprojPath);
  }

  // enable_thinking 经 --chat-template-kwargs 传递（新旧 llama.cpp 版本通吃，
  // 取代改名失效的 env 注入，见上方文件头注释）。写成 kwargs 对象的形态，
  // 为后续往同一个参数追加其他模板层开关（如 reasoning_effort）预留挂载点。
  const chatTemplateKwargs: Record<string, unknown> = {
    enable_thinking: server.enable_thinking,
  };
  // inherit 时不产出这个 key：不触发模板里任何依赖 reasoning_effort 的校验分支，
  // 完全交给模板自身默认值（见文件头注释与 lib/reasoning-effort.ts）
  if (server.reasoning_effort !== "inherit") {
    chatTemplateKwargs.reasoning_effort = server.reasoning_effort;
  }
  args.push("--chat-template-kwargs", JSON.stringify(chatTemplateKwargs));

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
