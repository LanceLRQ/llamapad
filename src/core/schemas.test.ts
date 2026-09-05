import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  apiConfigSchema,
  defaultConfigSchema,
  dockerConfigSchema,
  downloadSchema,
  modelSchema,
  NAMESPACE_PATTERN,
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

describe("dockerConfigSchema 新增字段（自定义镜像逃生口，§5.6）", () => {
  it("五个字段均可选：省略时全部为 undefined，其余合法值仍照常通过", () => {
    const result = defaultConfigSchema.safeParse(bashDefault);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.docker.model_mount).toBeUndefined();
      expect(result.data.docker.entrypoint).toBeUndefined();
      expect(result.data.docker.extra_args).toBeUndefined();
      expect(result.data.docker.args_override).toBeUndefined();
      expect(result.data.docker.env).toBeUndefined();
    }
  });

  it("model_mount：非空字符串通过，空串拒绝", () => {
    expect(ok(dockerConfigSchema, { ...bashDefault.docker, model_mount: "/mnt/models" })).toBe(true);
    expect(ok(dockerConfigSchema, { ...bashDefault.docker, model_mount: "" })).toBe(false);
  });

  it("entrypoint / extra_args / args_override：空数组与非空字符串数组通过，含空串元素拒绝", () => {
    for (const key of ["entrypoint", "extra_args", "args_override"] as const) {
      expect(ok(dockerConfigSchema, { ...bashDefault.docker, [key]: ["a", "b"] })).toBe(true);
      expect(ok(dockerConfigSchema, { ...bashDefault.docker, [key]: [] })).toBe(true);
      expect(ok(dockerConfigSchema, { ...bashDefault.docker, [key]: ["a", ""] })).toBe(false);
    }
  });

  it("env：元素须形如 KEY=value；空 value 允许，缺 = 或 KEY 非法均拒绝", () => {
    expect(ok(dockerConfigSchema, { ...bashDefault.docker, env: ["FOO=bar", "BAZ="] })).toBe(true);
    expect(ok(dockerConfigSchema, { ...bashDefault.docker, env: ["FOO"] })).toBe(false);
    expect(ok(dockerConfigSchema, { ...bashDefault.docker, env: ["1FOO=bar"] })).toBe(false);
  });

  it("overridesSchema 由 dockerConfigSchema.shape 自动派生：只覆盖 model_mount 时不会顺带注入其余字段", () => {
    const result = overridesSchema.safeParse({ docker: { model_mount: "/data" } });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ docker: { model_mount: "/data" } });
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

  it("reasoning_effort 只接受约定的枚举值，拒绝 default（刻意不进入项目语义）与任意字符串", () => {
    for (const v of ["inherit", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      expect(ok(defaultConfigSchema, withServer({ reasoning_effort: v }))).toBe(true);
    }
    expect(ok(defaultConfigSchema, withServer({ reasoning_effort: "default" }))).toBe(false);
    expect(ok(defaultConfigSchema, withServer({ reasoning_effort: "ultra" }))).toBe(false);
    expect(ok(defaultConfigSchema, withServer({ reasoning_effort: "" }))).toBe(false);
  });

  it("reasoning_effort 迁移护栏：存量 default_config JSON 不含该键时补 inherit 而非报错", () => {
    // bashDefault 本身就是「不含 reasoning_effort 键」的存量数据样例（这是本项目
    // 迁移前的真实形态）。repo/models.ts 的 getDefaultConfig() 对存量 JSON 做
    // safeParse 失败会直接抛错（刻意不静默）——若这个字段是必填，所有已保存过
    // 默认配置的现有部署一读就崩，这条测试是防回归的护栏。
    const result = defaultConfigSchema.safeParse(bashDefault);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.server.reasoning_effort).toBe("inherit");
  });
});

describe("apiConfigSchema（api 段，「思考强度中转映射」的中转行为，不属于 server 启动参数集）", () => {
  it("空对象即可通过，effort_aliases/effort_rounding 补默认值（{} / down）", () => {
    const result = apiConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.effort_aliases).toEqual({});
      expect(result.data.effort_rounding).toBe("down");
    }
  });

  it("effort_aliases 接受任意字符串到字符串的映射", () => {
    expect(ok(apiConfigSchema, { effort_aliases: { high: "xhigh", low: "minimal" } })).toBe(true);
  });

  it("effort_rounding 只接受 down/up/off", () => {
    for (const v of ["down", "up", "off"]) {
      expect(ok(apiConfigSchema, { effort_rounding: v })).toBe(true);
    }
    expect(ok(apiConfigSchema, { effort_rounding: "sideways" })).toBe(false);
  });

  it("default_config 迁移护栏：存量 JSON 不含 api 键时补默认值而非报错" +
    "（与 reasoning_effort 同一护栏理由：getDefaultConfig() 对存量数据 safeParse 失败会直接抛错）", () => {
    // bashDefault 本身就是「不含 api 键」的存量数据样例
    const result = defaultConfigSchema.safeParse(bashDefault);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.api).toEqual({ effort_aliases: {}, effort_rounding: "down" });
    }
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

  it("reasoning_effort 不被 .partial() 的 default 悄悄带入：与 model_mount 同源的 zod 4 坑，" +
    "覆盖其他字段时不会顺带注入 reasoning_effort:\"inherit\"", () => {
    // 若这条回归，说明 reasoning_effort 又变回带 default() 的定义被 serverConfigSchema.shape
    // 直接复用了——任何一次局部 server 覆盖都会悄悄烙上 inherit，往后全局默认值改了也不再跟随
    const result = overridesSchema.safeParse({ server: { top_k: 5 } });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ server: { top_k: 5 } });
  });

  it("reasoning_effort 显式给出时仍按枚举值域校验", () => {
    expect(ok(overridesSchema, { server: { reasoning_effort: "low" } })).toBe(true);
    expect(ok(overridesSchema, { server: { reasoning_effort: "bogus" } })).toBe(false);
  });

  it("api 段整体可选：覆盖 docker/server 时不会顺带注入 api 键", () => {
    const result = overridesSchema.safeParse({ server: { top_k: 5 } });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).not.toHaveProperty("api");
  });

  it("api.effort_aliases/effort_rounding 不被 .partial() 的 default 悄悄带入：" +
    "与 reasoning_effort/model_mount 同源的 zod 4 坑，只给 effort_rounding 时不会顺带注入 effort_aliases:{}", () => {
    // 若这条回归，说明 api 段又被 apiConfigSchema.shape 的 default 字段直接复用了——
    // 任何一次局部 api 覆盖都会悄悄烙上 effort_aliases:{}，全局默认改了也不再跟随
    const result = overridesSchema.safeParse({ api: { effort_rounding: "off" } });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ api: { effort_rounding: "off" } });
  });

  it("api 段只给 effort_aliases 时同样不会顺带注入 effort_rounding", () => {
    const result = overridesSchema.safeParse({ api: { effort_aliases: { high: "xhigh" } } });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ api: { effort_aliases: { high: "xhigh" } } });
  });

  it("api 段内未知键拒绝（strict，防拼写错误静默丢失）", () => {
    expect(ok(overridesSchema, { api: { effort_roundingg: "down" } })).toBe(false);
  });

  it("api 段字段类型仍受校验", () => {
    expect(ok(overridesSchema, { api: { effort_rounding: "sideways" } })).toBe(false);
    expect(ok(overridesSchema, { api: { effort_aliases: "not-a-record" } })).toBe(false);
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

describe("downloadSchema 嵌套用法：nullable() 对比 union([schema, null])", () => {
  /**
   * PUT /api/v1/models/:name 的 putBodySchema（route.ts）里 download 字段写作
   * downloadSchema.nullable().optional()，此处原样构一个同结构的最小 schema 复核该
   * 写法的报错路径粒度——不导入 route.ts，只验证 downloadSchema（discriminatedUnion）
   * 与 nullable() 组合时的 zod 契约本身。
   */
  const nullableField = z.strictObject({ download: downloadSchema.nullable().optional() });

  it("nullable() 包装：分支匹配失败时字段级路径完整保留（缺 file 落到 download.file）", () => {
    const result = nullableField.safeParse({ download: { source: "hf", repo: "x" } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["download", "file"]);
      expect(result.error.issues[0].message).toMatch(/expected string/i);
    }
  });

  it("null 仍可通过（清空语义）", () => {
    expect(nullableField.safeParse({ download: null }).success).toBe(true);
  });

  it("对照：z.union([downloadSchema, z.null()]) 会把字段级路径糊成顶层 invalid_union", () => {
    const unionField = z.strictObject({
      download: z.union([downloadSchema, z.null()]).optional(),
    });
    const result = unionField.safeParse({ download: { source: "hf", repo: "x" } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["download"]);
    }
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
    // "My_Ns" 即便放开了下划线也仍非法：大写字母才是这里被拒的原因（B7 不放开大写）
    expect(ok(modelSchema, { ...validModel, namespace: "My_Ns" })).toBe(false);
    expect(ok(modelSchema, { ...validModel, namespace: "experiments" })).toBe(true);
  });

  it("B7：namespace 放开点号与下划线，大写/危险形态仍拒绝", () => {
    expect(ok(modelSchema, { ...validModel, namespace: "qwen3.6" })).toBe(true);
    expect(ok(modelSchema, { ...validModel, namespace: "a_b" })).toBe(true);
    expect(ok(modelSchema, { ...validModel, namespace: "v1.0.0" })).toBe(true);
    expect(ok(modelSchema, { ...validModel, namespace: ".." })).toBe(false);
    expect(ok(modelSchema, { ...validModel, namespace: ".hidden" })).toBe(false);
    expect(ok(modelSchema, { ...validModel, namespace: "Main" })).toBe(false);
    expect(ok(modelSchema, { ...validModel, namespace: "a/b" })).toBe(false);
  });
});

describe("NAMESPACE_PATTERN", () => {
  it("首字符仍限定小写字母/数字，天然排除 . / .. / .hidden；新旧合法名均通过", () => {
    for (const name of ["main", "test-ns", "qwen3.6", "a_b", "v1.0.0"]) {
      expect(NAMESPACE_PATTERN.test(name)).toBe(true);
    }
    for (const name of ["..", ".", ".hidden", "Main", "a/b", ""]) {
      expect(NAMESPACE_PATTERN.test(name)).toBe(false);
    }
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

  it("空对象通过并填充默认值（host 留空待优先级链解析，panel 走 compose 固定约定）", () => {
    const result = panelSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.paths.models.host).toBeUndefined();
      expect(result.data.paths.models.panel).toBe("/host-models");
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

  it("panel.yaml 的 chat.base_url 可省略（缺省空对象）", () => {
    const parsed = panelSchema.parse({});
    expect(parsed.chat).toEqual({});
  });

  it("panel.yaml 的 chat.base_url 必须是合法 URL", () => {
    expect(ok(panelSchema, { chat: { base_url: "not-a-url" } })).toBe(false);
    expect(ok(panelSchema, { chat: { base_url: "https://llama-api.example.com" } })).toBe(true);
  });
});

describe("serverConfigSchema：切分参数（多卡支持批次）", () => {
  it("三个字段都可缺省——存量 default_config 不含新键也照常解析", () => {
    expect(defaultConfigSchema.safeParse(bashDefault).success).toBe(true);
  });
  it("split_mode 只认四档枚举", () => {
    for (const mode of ["none", "layer", "row", "tensor"]) {
      expect(overridesSchema.safeParse({ server: { split_mode: mode } }).success).toBe(true);
    }
    expect(overridesSchema.safeParse({ server: { split_mode: "pipeline" } }).success).toBe(false);
  });
  it("tensor_split 认逗号分隔的整数与小数，拒空项与非数字", () => {
    for (const value of ["1", "3,1", "0.7,0.3", "1,1,1,1"]) {
      expect(overridesSchema.safeParse({ server: { tensor_split: value } }).success).toBe(true);
    }
    for (const value of ["", "3,", "3,,1", "3;1", "a,b"]) {
      expect(overridesSchema.safeParse({ server: { tensor_split: value } }).success).toBe(false);
    }
  });
  it("main_gpu 是非负整数", () => {
    expect(overridesSchema.safeParse({ server: { main_gpu: 0 } }).success).toBe(true);
    expect(overridesSchema.safeParse({ server: { main_gpu: 3 } }).success).toBe(true);
    expect(overridesSchema.safeParse({ server: { main_gpu: -1 } }).success).toBe(false);
    expect(overridesSchema.safeParse({ server: { main_gpu: 1.5 } }).success).toBe(false);
  });
  it("局部覆盖不会被烙上未写过的切分参数（zod 4 .default() 实体化陷阱的回归守卫）", () => {
    const parsed = overridesSchema.parse({ server: { gpu_layers: 10 } });
    expect(parsed.server).toEqual({ gpu_layers: 10 });
  });
});
