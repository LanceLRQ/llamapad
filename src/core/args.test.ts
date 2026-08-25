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
 *   - enable_thinking=false 产出 --reasoning-format none（bash 走 docker env）
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

  it("enable_thinking 不产出任何 args（M4 真机修正：改走容器 env LLAMA_CHAT_TEMPLATE_KWARGS）", () => {
    // --reasoning-format none 只是不解析思考标签，不是关闭思考（模型照常吐 <think>，
    // 实测 35B false 时 content 直吐思考文本）。关闭思考的正解是 bash 同款
    // 模板层开关：容器 env LLAMA_CHAT_TEMPLATE_KWARGS（见 runtime/docker-options）
    const off = build({ server: { ...server, enable_thinking: false } });
    expect(off.includes("--reasoning-format")).toBe(false);

    const on = build({ server: { ...server, enable_thinking: true } });
    expect(on.includes("--reasoning-format")).toBe(false);
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
