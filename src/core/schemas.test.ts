import { describe, expect, it } from "vitest";
import {
  defaultConfigSchema,
  downloadSchema,
  modelSchema,
  overridesSchema,
  panelSchema,
  type DefaultConfig,
} from "./schemas";

/**
 * bash 前身（llama-launcher）默认配置，作为全字段合法样例。
 * 差异：docker 段的 GPU 字段按设计文档 §5 采用修正后的名字 `gpu`
 * （bash 版为 gpu_devices 且不生效）。
 */
const bashDefault = {
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
  },
} as const;

/** 在合法样例上打 docker 段补丁 */
function withDocker(patch: Record<string, unknown>): unknown {
  return { ...bashDefault, docker: { ...bashDefault.docker, ...patch } };
}

/** 在合法样例上打 server 段补丁 */
function withServer(patch: Record<string, unknown>): unknown {
  return { ...bashDefault, server: { ...bashDefault.server, ...patch } };
}

function ok(schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown): boolean {
  return schema.safeParse(value).success;
}

describe("defaultConfigSchema", () => {
  it("接受全字段合法样例（bash 版参数集，gpu 为设计文档修正字段名）", () => {
    const result = defaultConfigSchema.safeParse(bashDefault);
    expect(result.success).toBe(true);
    if (result.success) {
      const cfg: DefaultConfig = result.data;
      expect(cfg.docker.image).toBe("ghcr.io/ggml-org/llama.cpp:server-cuda");
      expect(cfg.docker.gpu).toBe("all");
      expect(cfg.server.temp).toBe(0.7);
      expect(cfg.server.cont_batching).toBe(true);
    }
  });

  it("接受设计文档 §5 的宿主机视角 model_volume", () => {
    expect(ok(defaultConfigSchema, withDocker({ model_volume: "/srv/llama/models:/models" }))).toBe(true);
  });

  it("docker 段缺 image 拒绝", () => {
    const { image: _image, ...dockerWithoutImage } = bashDefault.docker;
    expect(ok(defaultConfigSchema, { ...bashDefault, docker: dockerWithoutImage })).toBe(false);
  });

  it("host_port 越界拒绝（70000），边界 65535 通过", () => {
    expect(ok(defaultConfigSchema, withDocker({ host_port: 70000 }))).toBe(false);
    expect(ok(defaultConfigSchema, withDocker({ host_port: 65535 }))).toBe(true);
    expect(ok(defaultConfigSchema, withDocker({ host_port: 0 }))).toBe(false);
  });

  it("container_port 同样要求 1-65535 整数", () => {
    expect(ok(defaultConfigSchema, withDocker({ container_port: 8080.5 }))).toBe(false);
    expect(ok(defaultConfigSchema, withDocker({ container_port: 1 }))).toBe(true);
  });

  it("model_volume 必须形如 /host:/container（两侧非空路径）", () => {
    expect(ok(defaultConfigSchema, withDocker({ model_volume: "./models:/models" }))).toBe(true);
    expect(ok(defaultConfigSchema, withDocker({ model_volume: "/srv/llama/models:/models" }))).toBe(true);
    expect(ok(defaultConfigSchema, withDocker({ model_volume: ":/models" }))).toBe(false);
    expect(ok(defaultConfigSchema, withDocker({ model_volume: "/models:" }))).toBe(false);
    expect(ok(defaultConfigSchema, withDocker({ model_volume: "models" }))).toBe(false);
    expect(ok(defaultConfigSchema, withDocker({ model_volume: "a:b:c" }))).toBe(false);
  });

  it("gpu 只接受 all | none | device=N[,N…]", () => {
    for (const gpu of ["all", "none", "device=0", "device=0,1", "device=0,1,2"]) {
      expect(ok(defaultConfigSchema, withDocker({ gpu }))).toBe(true);
    }
    for (const gpu of ["device=x", "gpu", "device=0,", "device=", "ALL"]) {
      expect(ok(defaultConfigSchema, withDocker({ gpu }))).toBe(false);
    }
  });

  it("container_name 按容器名格式校验", () => {
    expect(ok(defaultConfigSchema, withDocker({ container_name: "llama-server" }))).toBe(true);
    expect(ok(defaultConfigSchema, withDocker({ container_name: "qwen llama" }))).toBe(false);
    expect(ok(defaultConfigSchema, withDocker({ container_name: "-bad" }))).toBe(false);
  });
});

describe("serverConfigSchema（经 defaultConfigSchema）", () => {
  it("cache_type_k/v 只接受枚举值", () => {
    for (const t of ["f16", "q8_0", "q4_0", "q4_k", "q5_0", "q5_k", "q6_k", "q8_k"]) {
      expect(ok(defaultConfigSchema, withServer({ cache_type_k: t }))).toBe(true);
      expect(ok(defaultConfigSchema, withServer({ cache_type_v: t }))).toBe(true);
    }
    for (const t of ["q3_0", "Q4_0", "f32", 42]) {
      expect(ok(defaultConfigSchema, withServer({ cache_type_k: t }))).toBe(false);
      expect(ok(defaultConfigSchema, withServer({ cache_type_v: t }))).toBe(false);
    }
  });

  it("ctx_size/gpu_layers 等数值字段要求非负整数", () => {
    expect(ok(defaultConfigSchema, withServer({ ctx_size: -1 }))).toBe(false);
    expect(ok(defaultConfigSchema, withServer({ ctx_size: 1.5 }))).toBe(false);
    expect(ok(defaultConfigSchema, withServer({ ctx_size: 0 }))).toBe(true);
    expect(ok(defaultConfigSchema, withServer({ gpu_layers: -5 }))).toBe(false);
    expect(ok(defaultConfigSchema, withServer({ gpu_layers: 0 }))).toBe(true);
    expect(ok(defaultConfigSchema, withServer({ top_k: -1 }))).toBe(false);
    expect(ok(defaultConfigSchema, withServer({ batch_size: 0 }))).toBe(false);
    expect(ok(defaultConfigSchema, withServer({ ubatch_size: 0 }))).toBe(false);
  });

  it("temp 在 [0,2]，top_p/min_p 在 [0,1]", () => {
    for (const temp of [0, 1, 2]) {
      expect(ok(defaultConfigSchema, withServer({ temp }))).toBe(true);
    }
    for (const temp of [-0.1, 2.1]) {
      expect(ok(defaultConfigSchema, withServer({ temp }))).toBe(false);
    }
    for (const p of [0, 1]) {
      expect(ok(defaultConfigSchema, withServer({ top_p: p }))).toBe(true);
      expect(ok(defaultConfigSchema, withServer({ min_p: p }))).toBe(true);
    }
    expect(ok(defaultConfigSchema, withServer({ top_p: 1.5 }))).toBe(false);
    expect(ok(defaultConfigSchema, withServer({ min_p: 1.01 }))).toBe(false);
  });

  it("flash_attention 只接受 on/off，布尔字段不接受字符串", () => {
    expect(ok(defaultConfigSchema, withServer({ flash_attention: "off" }))).toBe(true);
    expect(ok(defaultConfigSchema, withServer({ flash_attention: "true" }))).toBe(false);
    expect(ok(defaultConfigSchema, withServer({ cont_batching: "yes" }))).toBe(false);
    expect(ok(defaultConfigSchema, withServer({ enable_thinking: true }))).toBe(true);
  });
});

describe("overridesSchema", () => {
  it("空对象通过", () => {
    const result = overridesSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({});
  });

  it("只给 server.gpu_layers 通过，且不注入默认值", () => {
    const result = overridesSchema.safeParse({ server: { gpu_layers: 5 } });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ server: { gpu_layers: 5 } });
  });

  it("只给 docker 段部分字段通过", () => {
    expect(ok(overridesSchema, { docker: { host_port: 8080 } })).toBe(true);
  });

  it("顶层未知键拒绝（strict）", () => {
    expect(ok(overridesSchema, { unknown: true })).toBe(false);
    expect(ok(overridesSchema, { dockerr: {} })).toBe(false);
  });

  it("段内未知键拒绝（防拼写错误静默丢失）", () => {
    expect(ok(overridesSchema, { server: { gpu_layerz: 5 } })).toBe(false);
    expect(ok(overridesSchema, { docker: { host_prot: 8080 } })).toBe(false);
  });

  it("段内字段类型仍受校验", () => {
    expect(ok(overridesSchema, { server: { temp: 99 } })).toBe(false);
    expect(ok(overridesSchema, { docker: { image: 42 } })).toBe(false);
  });
});

describe("downloadSchema", () => {
  it("source=hf：repo + file 通过", () => {
    const result = downloadSchema.safeParse({
      source: "hf",
      repo: "Qwen/Qwen3-7B-GGUF",
      file: "Qwen3-7B-Q4_K_M.gguf",
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.source === "hf") {
      expect(result.data.repo).toBe("Qwen/Qwen3-7B-GGUF");
    }
  });

  it("source=url：url + file 通过", () => {
    expect(
      ok(downloadSchema, { source: "url", url: "https://example.com/x.gguf", file: "x.gguf" }),
    ).toBe(true);
  });

  it("source=hf 缺 repo 拒绝", () => {
    expect(ok(downloadSchema, { source: "hf", file: "x.gguf" })).toBe(false);
  });

  it("source=url 缺 url 拒绝", () => {
    expect(ok(downloadSchema, { source: "url", repo: "a/b", file: "x.gguf" })).toBe(false);
  });

  it("未知 source（modelscope）拒绝", () => {
    expect(
      ok(downloadSchema, { source: "modelscope", repo: "a/b", file: "x.gguf" }),
    ).toBe(false);
  });

  it("sha256 可选，必须是 64 位小写 hex", () => {
    const good = "a".repeat(64);
    expect(ok(downloadSchema, { source: "hf", repo: "a/b", file: "x.gguf", sha256: good })).toBe(true);
    expect(ok(downloadSchema, { source: "hf", repo: "a/b", file: "x.gguf", sha256: "xyz" })).toBe(false);
    expect(ok(downloadSchema, { source: "hf", repo: "a/b", file: "x.gguf", sha256: "a".repeat(63) })).toBe(false);
    expect(ok(downloadSchema, { source: "hf", repo: "a/b", file: "x.gguf", sha256: "A".repeat(64) })).toBe(false);
  });
});

describe("modelSchema", () => {
  const validModel = {
    name: "qwen-7b",
    display_name: "Qwen 7B",
    gguf_file: "main/qwen.gguf",
  };

  it("最小合法模型通过，namespace 默认 main", () => {
    const result = modelSchema.safeParse(validModel);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.namespace).toBe("main");
      expect(result.data.overrides).toEqual({});
    }
  });

  it("name 必须匹配 ^[a-z0-9][a-z0-9-]*$", () => {
    expect(ok(modelSchema, { ...validModel, name: "Qwen/7b" })).toBe(false);
    expect(ok(modelSchema, { ...validModel, name: "-qwen" })).toBe(false);
    expect(ok(modelSchema, { ...validModel, name: "qwen-7b" })).toBe(true);
  });

  it("display_name 任意非空", () => {
    expect(ok(modelSchema, { ...validModel, display_name: "任意名字 😀" })).toBe(true);
    expect(ok(modelSchema, { ...validModel, display_name: "" })).toBe(false);
  });

  it("gguf_file 为相对 models 根的 .gguf 路径", () => {
    expect(ok(modelSchema, { ...validModel, gguf_file: "shared/big.gguf" })).toBe(true);
    expect(ok(modelSchema, { ...validModel, gguf_file: "/abs/qwen.gguf" })).toBe(false);
    expect(ok(modelSchema, { ...validModel, gguf_file: "main/qwen.txt" })).toBe(false);
  });

  it("mmproj_file 可选，同样按相对 .gguf 路径校验", () => {
    expect(ok(modelSchema, { ...validModel, mmproj_file: "main/mmproj-F16.gguf" })).toBe(true);
    expect(ok(modelSchema, { ...validModel, mmproj_file: "/mmproj.gguf" })).toBe(false);
  });

  it("download 可选且整体校验", () => {
    expect(
      ok(modelSchema, { ...validModel, download: { source: "hf", repo: "a/b", file: "x.gguf" } }),
    ).toBe(true);
    expect(
      ok(modelSchema, { ...validModel, download: { source: "modelscope", repo: "a/b", file: "x.gguf" } }),
    ).toBe(false);
  });

  it("namespace 非法时拒绝", () => {
    expect(ok(modelSchema, { ...validModel, namespace: "My_Ns" })).toBe(false);
    expect(ok(modelSchema, { ...validModel, namespace: "experiments" })).toBe(true);
  });
});

describe("panelSchema（panel.yaml）", () => {
  it("接受设计文档 §5.1 的完整样例", () => {
    const result = panelSchema.safeParse({
      paths: { models: { host: "/srv/llama/models", panel: "/srv/llama/models" } },
      proxy: "http://127.0.0.1:7890",
      listen: { host: "0.0.0.0", port: 8080 },
    });
    expect(result.success).toBe(true);
  });

  it("空对象通过并填充默认值（约定挂载可自动推断）", () => {
    const result = panelSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.paths.models.host).toBe("/srv/llama/models");
      expect(result.data.paths.models.panel).toBe("/srv/llama/models");
      expect(result.data.listen).toEqual({ host: "0.0.0.0", port: 8080 });
      expect(result.data.proxy).toBeUndefined();
    }
  });

  it("proxy 可选，但必须是合法 URL", () => {
    expect(ok(panelSchema, { proxy: "http://127.0.0.1:7890" })).toBe(true);
    expect(ok(panelSchema, { proxy: "socks5://127.0.0.1:1080" })).toBe(true);
    expect(ok(panelSchema, { proxy: "not a url" })).toBe(false);
    expect(ok(panelSchema, { proxy: "127.0.0.1:7890" })).toBe(false);
  });

  it("listen.port 越界拒绝", () => {
    expect(ok(panelSchema, { listen: { host: "0.0.0.0", port: 70000 } })).toBe(false);
  });

  it("paths.models.host 不允许空字符串", () => {
    expect(
      ok(panelSchema, { paths: { models: { host: "", panel: "/srv/llama/models" } } }),
    ).toBe(false);
  });
});
