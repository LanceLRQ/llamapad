import { describe, expect, it } from "vitest";
import type { DefaultConfig, Overrides } from "./schemas";
import { defaultConfigSchema } from "./schemas";
import { BUILTIN_DEFAULT_CONFIG, effectiveParams, mergeConfig } from "./config";

/**
 * 测试自有的 defaults 样例（bash 前身默认，与实现内的内置默认相互独立，
 * 避免用实现产物断言实现）。
 */
const defaults: DefaultConfig = {
  docker: {
    image: "ghcr.io/ggml-org/llama.cpp:server-cuda",
    container_name: "qwen-llama-server",
    model_volume: "./models:/models",
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

/** 把任意非法输入当作 Overrides 传入（绕过 TS，只测运行时校验） */
function bad(value: unknown): Overrides {
  return value as Overrides;
}

describe("mergeConfig", () => {
  it("只覆盖指定键：server.gpu_layers 生效，其余 16 个 server 键不变，docker 段完全不动", () => {
    const merged = mergeConfig(defaults, { server: { gpu_layers: 999 } });

    expect(merged.server.gpu_layers).toBe(999);

    // server 段仍为完整 17 键（新增 reasoning_effort 后），其余 16 键逐个与 defaults 相同
    const serverKeys = Object.keys(defaults.server);
    expect(serverKeys).toHaveLength(17);
    expect(Object.keys(merged.server)).toHaveLength(17);
    for (const key of serverKeys) {
      if (key === "gpu_layers") continue;
      expect(merged.server[key as keyof DefaultConfig["server"]]).toBe(
        defaults.server[key as keyof DefaultConfig["server"]],
      );
    }

    // docker 段完全不动
    expect(merged.docker).toEqual(defaults.docker);
  });

  it("空 overrides 返回与 defaults 相等的结果，且是深拷贝（改返回值不影响 defaults）", () => {
    const merged = mergeConfig(defaults, {});
    expect(merged).toEqual(defaults);
    expect(merged).not.toBe(defaults);
    expect(merged.docker).not.toBe(defaults.docker);
    expect(merged.server).not.toBe(defaults.server);

    merged.server.temp = 1.23;
    merged.docker.host_port = 1234;
    expect(defaults.server.temp).toBe(0.7);
    expect(defaults.docker.host_port).toBe(18080);
  });

  it("docker 与 server 两段同时覆盖", () => {
    const merged = mergeConfig(defaults, { docker: { host_port: 9000 }, server: { temp: 0.1 } });
    expect(merged.docker.host_port).toBe(9000);
    expect(merged.server.temp).toBe(0.1);
    expect(merged.docker.image).toBe(defaults.docker.image);
    expect(merged.server.gpu_layers).toBe(defaults.server.gpu_layers);
  });

  it("非法 overrides 抛出含字段路径/键名的错误（mergeConfig 与 effectiveParams 行为一致）", () => {
    expect(() => mergeConfig(defaults, bad({ server: { temp: 99 } }))).toThrow(/server\.temp/);
    // 拼写错误键：strict 拒绝，message 应包含错误键名
    expect(() => mergeConfig(defaults, bad({ docker: { host_prot: 8080 } }))).toThrow(/host_prot/);
    expect(() => effectiveParams(defaults, bad({ server: { temp: 99 } }))).toThrow(/server\.temp/);
  });
});

describe("effectiveParams", () => {
  it("输出扁平 Record，键为 段名.字段名，共 23 键（docker 6 + server 17），值为合并结果", () => {
    const params = effectiveParams(defaults, {
      server: { gpu_layers: 999 },
      docker: { host_port: 9000 },
    });

    expect(Object.keys(params)).toHaveLength(23);
    expect(Object.keys(params).filter((k) => k.startsWith("docker."))).toHaveLength(6);
    expect(Object.keys(params).filter((k) => k.startsWith("server."))).toHaveLength(17);

    expect(params["server.gpu_layers"]).toBe(999);
    expect(params["docker.host_port"]).toBe(9000);
    expect(params["server.temp"]).toBe(defaults.server.temp);
    expect(params["docker.gpu"]).toBe("all");
    expect(params["server.cont_batching"]).toBe(true);

    // 值类型仅 string | number | boolean
    for (const value of Object.values(params)) {
      expect(["string", "number", "boolean"]).toContain(typeof value);
    }
  });
});

describe("BUILTIN_DEFAULT_CONFIG", () => {
  it("内置默认配置通过 defaultConfigSchema 校验", () => {
    expect(defaultConfigSchema.safeParse(BUILTIN_DEFAULT_CONFIG).success).toBe(true);
  });
});
