import { describe, expect, it } from "vitest";
import { BUILTIN_DEFAULT_CONFIG, mergeConfig } from "./config";
import type { ServerConfig } from "./schemas";
import { buildArgs } from "./args";

/**
 * buildArgs 参数映射测试（M0 Task 6）
 *
 * 断言依据 bash 前身 model-manager.sh L396-418 的 docker run 尾部参数表：
 *   -m <model> --host <host> --ctx-size <n> --gpu-layers <n> --flash-attn on|off
 *   --batch-size <n> --ubatch-size <n> -ctk <t> -ctv <t> [--cont-batching]
 *   [--mmproj <path>] --repeat-penalty .. --presence-penalty .. --min-p ..
 *   --top-k .. --top-p .. --temp ..
 * 差异（任务规格要求，见 args.ts 注释）：
 *   - cache 类型用等价长格式 --cache-type-k/--cache-type-v（bash 用短格式 -ctk/-ctv）
 *   - 显式传 --port <容器端口>（bash 未传，依赖镜像默认 8080）
 *   - enable_thinking 产出 --chat-template-kwargs {"enable_thinking":<bool>}
 *     （CLI 参数，新旧 llama.cpp 版本通吃；bash 版走 docker env，且该 env 名
 *     已被上游改名弃用，详见 args.ts 注释）
 */

/** 测试自有的 server 段样例（与实现内置默认相互独立） */
const server: ServerConfig = {
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
};

const MODEL_PATH = "/models/main/qwen3.5.gguf";
const MMPROJ_PATH = "/models/main/mmproj.gguf";
const PORT = 8080;

function build(over: Partial<Parameters<typeof buildArgs>[0]> = {}) {
  return buildArgs({ server, modelPath: MODEL_PATH, port: PORT, ...over });
}

/** 取 "--flag value" 形式的 value；flag 不存在则抛出（fail fast） */
function valueOf(args: string[], flag: string): string {
  const i = args.indexOf(flag);
  if (i === -1) throw new Error(`args 中不存在 ${flag}: [${args.join(" ")}]`);
  return args[i + 1];
}

describe("buildArgs：值参数映射（对照 bash 版参数表）", () => {
  it("默认参数集产出正确的键值对（--ctx-size 131072 / --gpu-layers 99 / --cache-type-k q4_0 等）", () => {
    const args = build();

    expect(valueOf(args, "-m")).toBe(MODEL_PATH);
    expect(valueOf(args, "--host")).toBe("0.0.0.0");
    expect(valueOf(args, "--port")).toBe("8080");
    expect(valueOf(args, "--ctx-size")).toBe("131072");
    expect(valueOf(args, "--gpu-layers")).toBe("99");
    expect(valueOf(args, "--batch-size")).toBe("4096");
    expect(valueOf(args, "--ubatch-size")).toBe("1024");
    expect(valueOf(args, "--cache-type-k")).toBe("q4_0");
    expect(valueOf(args, "--cache-type-v")).toBe("q4_0");
  });

  it("采样参数五项键名正确（--repeat-penalty / --presence-penalty / --min-p / --top-k / --top-p / --temp）", () => {
    const args = build();

    expect(valueOf(args, "--repeat-penalty")).toBe("1");
    expect(valueOf(args, "--presence-penalty")).toBe("1.5");
    expect(valueOf(args, "--min-p")).toBe("0");
    expect(valueOf(args, "--top-k")).toBe("20");
    expect(valueOf(args, "--top-p")).toBe("0.8");
    expect(valueOf(args, "--temp")).toBe("0.7");
  });

  it("flash_attention 按值传递：on → --flash-attn on，off → --flash-attn off（bash 版写法）", () => {
    expect(valueOf(build({ server: { ...server, flash_attention: "on" } }), "--flash-attn")).toBe(
      "on",
    );
    expect(valueOf(build({ server: { ...server, flash_attention: "off" } }), "--flash-attn")).toBe(
      "off",
    );
  });

  it("--port 使用传入的容器端口（而非宿主端口）", () => {
    expect(valueOf(build({ port: 9999 }), "--port")).toBe("9999");
  });

  it("mmproj 提供时产出 --mmproj，未提供时不产出", () => {
    expect(valueOf(build({ mmprojPath: MMPROJ_PATH }), "--mmproj")).toBe(MMPROJ_PATH);
    expect(build().includes("--mmproj")).toBe(false);
  });
});

describe("buildArgs：布尔参数映射", () => {
  it("cont_batching=true 产出 --cont-batching 纯开关（bash 版无值写法）；false 不产出", () => {
    const on = build({ server: { ...server, cont_batching: true } });
    expect(on).toContain("--cont-batching");
    // 纯开关：后一个元素不是它的值（是下一个 flag 或结尾）
    const i = on.indexOf("--cont-batching");
    expect(on[i + 1]).not.toBe("true");

    expect(build({ server: { ...server, cont_batching: false } }).includes("--cont-batching")).toBe(
      false,
    );
  });

  it("默认产出 --metrics（面板推理指标依赖 /metrics prometheus 端点，M4 真机定案）", () => {
    // llama.cpp 默认不暴露 /metrics（501），tok/s 差分依赖该端点的计数器
    const out = build({ server });
    expect(out).toContain("--metrics");
  });

  it("enable_thinking 产出 --chat-template-kwargs（CLI 参数，取代改名失效的 env 注入）", () => {
    // 上游把 env LLAMA_CHAT_TEMPLATE_KWARGS 改名为 LLAMA_ARG_CHAT_TEMPLATE_KWARGS，
    // 旧名在新版镜像上完全失效（实测：思考仍开启）。CLI 参数
    // --chat-template-kwargs 新旧版本 llama.cpp 都支持（实测 b8173 与 build
    // 10450 均可），一次性摆脱 env 改名问题，见 args.ts 注释
    const off = build({ server: { ...server, enable_thinking: false } });
    expect(valueOf(off, "--chat-template-kwargs")).toBe('{"enable_thinking":false}');

    const on = build({ server: { ...server, enable_thinking: true } });
    expect(valueOf(on, "--chat-template-kwargs")).toBe('{"enable_thinking":true}');
  });

  it("reasoning_effort=inherit 时 --chat-template-kwargs 只含 enable_thinking", () => {
    const args = build({ server: { ...server, reasoning_effort: "inherit" } });
    expect(valueOf(args, "--chat-template-kwargs")).toBe('{"enable_thinking":false}');
  });

  it("reasoning_effort 非 inherit 时与 enable_thinking 合并进同一个 --chat-template-kwargs", () => {
    const args = build({ server: { ...server, reasoning_effort: "low" } });
    // key 顺序与实现写入顺序一致：enable_thinking 先于 reasoning_effort
    expect(valueOf(args, "--chat-template-kwargs")).toBe('{"enable_thinking":false,"reasoning_effort":"low"}');
  });
});

describe("buildArgs：形态与组合", () => {
  it("输出不含程序名 llama-server，首参数为 -m（程序名由容器入口提供）", () => {
    const args = build();
    expect(args.includes("llama-server")).toBe(false);
    expect(args[0]).toBe("-m");
    expect(args[1]).toBe(MODEL_PATH);
  });

  it("与 mergeConfig 串联：overrides 改 ctx_size 后 buildArgs 用新值，未覆盖字段沿用默认", () => {
    const merged = mergeConfig(BUILTIN_DEFAULT_CONFIG, {
      server: { ctx_size: 8192, flash_attention: "off" },
    });
    const args = buildArgs({
      server: merged.server,
      modelPath: "/models/main/test.gguf",
      port: merged.docker.container_port,
    });

    expect(valueOf(args, "--ctx-size")).toBe("8192");
    expect(valueOf(args, "--flash-attn")).toBe("off");
    // 未覆盖字段沿用内置默认（gpu_layers=99 / cache_type_v=q4_0）
    expect(valueOf(args, "--gpu-layers")).toBe("99");
    expect(valueOf(args, "--cache-type-v")).toBe("q4_0");
    expect(valueOf(args, "--port")).toBe(String(merged.docker.container_port));
  });
});
