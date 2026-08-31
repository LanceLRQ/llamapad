import { describe, expect, it } from "vitest";
import { BUILTIN_DEFAULT_CONFIG } from "./config";
import type { ModelConfig } from "./schemas";
import {
  applyImportConflict,
  fromBashDefaultYaml,
  fromBashYaml,
  fromExportYaml,
  toExportYaml,
  type ExportBundle,
} from "./yamlIo";

/**
 * YAML 导入导出纯函数测试（M2 Task 8）
 *
 * 覆盖：导出格式往返一致（嵌套 download/overrides、中文 display_name）、
 * 坏数据（YAML 语法错 / 缺段 / schema 不符）报错带字段路径、
 * bash 前身（llama-launcher）单模型 / default.yaml 的字段映射与
 * 不支持字段（jinja/no_mmap）warning 收集、导入冲突三策略。
 */

/** 一个覆盖面较全的 bundle：中文 display_name、hf/url 两种 download、嵌套 overrides */
function sampleBundle(): ExportBundle {
  const models: ModelConfig[] = [
    {
      name: "qwen3-8b",
      display_name: "Qwen3 8B 中文测试",
      namespace: "main",
      gguf_file: "main/Qwen3-8B-Q4_K_M.gguf",
      overrides: {
        server: { ctx_size: 32768, temp: 0.6 },
        docker: { host_port: 18081 },
      },
    },
    {
      name: "gemma-vlm",
      display_name: "Gemma 3 Vision",
      namespace: "shared",
      gguf_file: "shared/gemma-3-4b.gguf",
      mmproj_file: "shared/gemma-3-mmproj.gguf",
      download: {
        source: "hf",
        repo: "org/gemma-3-GGUF",
        file: "gemma-3-4b-Q4_K_M.gguf",
        sha256: "a".repeat(64),
      },
      overrides: {},
    },
    {
      name: "direct-url",
      display_name: "URL 直链模型",
      namespace: "main",
      gguf_file: "main/direct.gguf",
      download: { source: "url", url: "https://example.com/direct.gguf", file: "direct.gguf" },
      overrides: { server: { flash_attention: "off" } },
    },
  ];
  return {
    defaults: structuredClone(BUILTIN_DEFAULT_CONFIG),
    models,
    namespaces: ["main", "shared"],
  };
}

describe("toExportYaml / fromExportYaml（往返一致）", () => {
  it("往返后对象深度相等（含 download/overrides 嵌套与中文 display_name）", () => {
    const bundle = sampleBundle();
    const text = toExportYaml(bundle);
    expect(typeof text).toBe("string");
    expect(text).toContain("default_config:");
    expect(text).toContain("models:");
    expect(text).toContain("namespaces:");
    // 中文不转义为 \x 序列，肉眼可读
    expect(text).toContain("Qwen3 8B 中文测试");

    const restored = fromExportYaml(text);
    expect(restored).toEqual(bundle);
  });

  it("空模型集 / 空 namespaces 往返一致", () => {
    const bundle: ExportBundle = {
      defaults: structuredClone(BUILTIN_DEFAULT_CONFIG),
      models: [],
      namespaces: ["main"],
    };
    expect(fromExportYaml(toExportYaml(bundle))).toEqual(bundle);
  });

  it("repos 段：baseDir 空串是 models 根，是合法值，往返后仍是空串（不是 undefined）", () => {
    const bundle: ExportBundle = {
      ...sampleBundle(),
      repos: [
        { repo: "unsloth/Qwen3.5-4B-GGUF", baseDir: "" },
        { repo: "org/other-repo", baseDir: "hf" },
      ],
    };
    const text = toExportYaml(bundle);
    expect(text).toContain("repos:");

    const restored = fromExportYaml(text);
    expect(restored).toEqual(bundle);
    expect(restored.repos?.[0].baseDir).toBe("");
  });

  it("toExportYaml 剥离 StoredModel 的多余键（created_at 等）", () => {
    const bundle = sampleBundle();
    const withExtras = {
      ...bundle,
      models: bundle.models.map((m) => ({ ...m, created_at: "2026-01-01T00:00:00Z" })),
    } as unknown as ExportBundle;
    const text = toExportYaml(withExtras);
    expect(text).not.toContain("created_at");
    expect(fromExportYaml(text)).toEqual(bundle);
  });

  it("坏 YAML 语法 → 抛错，message 表明是 YAML 解析失败", () => {
    expect(() => fromExportYaml("default_config:\n  docker: [oops\n")).toThrow(/YAML/);
  });

  it("缺段（无 models / 无 default_config）→ 报错含缺失段名", () => {
    expect(() => fromExportYaml("default_config:\n  docker: {}\n")).toThrow(/models/);
    expect(() => fromExportYaml("models: []\nnamespaces: [main]\n")).toThrow(/default_config/);
  });

  it("schema 不符 → 报错含字段路径（default_config.docker.gpu）", () => {
    // fromExportYaml 侧：合法文本被篡改出非法 gpu
    const text = toExportYaml(sampleBundle()).replace("gpu: all", "gpu: everything");
    expect(() => fromExportYaml(text)).toThrow(/default_config\.docker\.gpu/);
    // toExportYaml 侧：入参本身非法同样带路径抛出
    const broken = sampleBundle();
    broken.defaults.docker.gpu = "everything" as never;
    expect(() => toExportYaml(broken)).toThrow(/default_config\.docker\.gpu/);
  });

  it("模型字段非法 → 报错含 models.<序号>.<字段> 路径", () => {
    const text = toExportYaml(sampleBundle()).replace("gguf_file: main/direct.gguf", "gguf_file: /abs/direct.gguf");
    expect(() => fromExportYaml(text)).toThrow(/models\.2\.gguf_file/);
  });
});

/** bash 前身 configs/models/template.yaml 的实值化样本（jinja/no_mmap 为 bash 独有） */
const BASH_MODEL_YAML = `model:
  name: qwen3-test
  display_name: "Qwen3 测试模型"
  gguf_file: Qwen3-Test.gguf
  mmproj_file: Qwen3-Test-mmproj.gguf

overrides:
  server:
    # 只覆盖与默认不同的参数
    ctx_size: 32768
    temp: 0.6
    jinja: true
    no_mmap: true
`;

describe("fromBashYaml（bash 单模型 → main 空间）", () => {
  it("解析 template 实值化样本：namespace=main、裸文件名加 main/ 前缀、已知字段透传", () => {
    const { model, warnings } = fromBashYaml(BASH_MODEL_YAML);
    expect(model.name).toBe("qwen3-test");
    expect(model.display_name).toBe("Qwen3 测试模型");
    expect(model.namespace).toBe("main");
    expect(model.gguf_file).toBe("main/Qwen3-Test.gguf");
    expect(model.mmproj_file).toBe("main/Qwen3-Test-mmproj.gguf");
    expect(model.overrides).toEqual({ server: { ctx_size: 32768, temp: 0.6 } });
    // bash 独有字段 → warning 收集，不抛错
    expect(warnings.some((w) => w.includes("jinja"))).toBe(true);
    expect(warnings.some((w) => w.includes("no_mmap"))).toBe(true);
  });

  it("bash gguf_file 已含目录（llama-launcher 真机布局）：路径原样保留，不加 main/ 前缀", () => {
    // 真机场景（M4 T3 发现）：bash 配置 gguf_file 本就相对 models 根且含子目录
    // （models/qwen3.6/xxx.gguf），加 main/ 前缀会指向不存在的 main/qwen3.6/
    const { model } = fromBashYaml(
      "model:\n  name: qwen36-35b\n  gguf_file: qwen3.6/Qwen3.6-35B.gguf\n  mmproj_file: qwen3.6/mmproj-F16.gguf\n",
    );
    expect(model.namespace).toBe("main");
    expect(model.gguf_file).toBe("qwen3.6/Qwen3.6-35B.gguf");
    expect(model.mmproj_file).toBe("qwen3.6/mmproj-F16.gguf");
  });

  it("display_name 缺省回退 name", () => {
    const { model } = fromBashYaml("model:\n  name: fallback-demo\n  gguf_file: F.gguf\n");
    expect(model.display_name).toBe("fallback-demo");
  });

  it("无 overrides / 无 mmproj → 空覆盖、字段缺省", () => {
    const { model, warnings } = fromBashYaml("model:\n  name: bare\n  gguf_file: Bare.gguf\n");
    expect(model.overrides).toEqual({});
    expect(model.mmproj_file).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("docker.gpu_devices 覆盖 → 映射为 gpu（数字列表转 device=）", () => {
    const { model } = fromBashYaml(
      "model:\n  name: gpu-map\n  gguf_file: G.gguf\noverrides:\n  docker:\n    gpu_devices: \"0,1\"\n",
    );
    expect(model.overrides.docker).toEqual({ gpu: "device=0,1" });
  });

  it("缺少 model 段 / name 非法 → 抛错（name 规则由 schema 裁决，带字段路径）", () => {
    expect(() => fromBashYaml("overrides:\n  server: {}\n")).toThrow(/model/);
    expect(() => fromBashYaml("model:\n  name: 非法名字\n  gguf_file: X.gguf\n")).toThrow(
      /model\.name|^bash 模型校验失败/,
    );
  });
});

/** bash 前身 configs/default.yaml 原文样本（缺 server 独有字段时由内置默认补齐） */
const BASH_DEFAULT_YAML = `docker:
  image: ghcr.io/ggml-org/llama.cpp:server-cuda
  container_name: qwen-llama-server
  model_volume: ./models:/models
  host_port: 18080
  gpu_devices: all

server:
  host: "0.0.0.0"
  ctx_size: 262144
  gpu_layers: 99
  flash_attention: "on"
  temp: 0.5
  jinja: true
`;

describe("fromBashDefaultYaml（bash default.yaml 字段映射）", () => {
  it("gpu_devices: all → gpu: all；host_port 等直传；缺 container_port 补 8080 过 schema", () => {
    const { defaults, warnings } = fromBashDefaultYaml(BASH_DEFAULT_YAML);
    expect(defaults.docker.gpu).toBe("all");
    expect(defaults.docker.host_port).toBe(18080);
    expect(defaults.docker.container_port).toBe(8080); // 缺失 → 内置默认补齐
    expect(defaults.docker.model_volume).toBe("./models:/models");
    expect(defaults.server.ctx_size).toBe(262144);
    expect(defaults.server.temp).toBe(0.5);
    // 未提供的 server 字段取内置默认
    expect(defaults.server.top_k).toBe(BUILTIN_DEFAULT_CONFIG.server.top_k);
    // bash 独有 server.jinja → warning
    expect(warnings.some((w) => w.includes("jinja"))).toBe(true);
  });

  it("gpu_devices 数字 → device=N 映射；gpu_devices: none → none", () => {
    const withDevices = BASH_DEFAULT_YAML.replace("gpu_devices: all", 'gpu_devices: "0,1"');
    expect(fromBashDefaultYaml(withDevices).defaults.docker.gpu).toBe("device=0,1");
    const withNone = BASH_DEFAULT_YAML.replace("gpu_devices: all", "gpu_devices: none");
    expect(fromBashDefaultYaml(withNone).defaults.docker.gpu).toBe("none");
  });

  it("整段缺失（无 server 段）→ 全部取内置默认仍过 schema", () => {
    const { defaults } = fromBashDefaultYaml("docker:\n  host_port: 19090\n  gpu_devices: all\n");
    expect(defaults.docker.host_port).toBe(19090);
    expect(defaults.server).toEqual(BUILTIN_DEFAULT_CONFIG.server);
  });

  it("字段值非法 → 抛错含字段路径", () => {
    expect(() => fromBashDefaultYaml("docker:\n  host_port: 70000\n")).toThrow(/docker\.host_port/);
  });
});

describe("applyImportConflict（导入冲突三策略）", () => {
  it("skip：冲突名进 skip，其余透传", () => {
    const r = applyImportConflict(["a", "b"], ["b", "c"], "skip");
    expect(r.skip).toEqual(["b"]);
    expect(r.renamed.size).toBe(0);
    expect(r.overwritten).toEqual([]);
  });

  it("rename：加 -1 后缀直到不冲突（目标名不得撞已有名与其他导入名）", () => {
    // a 冲突 → 先试 a-1，但 a-1 也是导入名 → a-2
    const r = applyImportConflict(["a"], ["a", "a-1", "c"], "rename");
    expect(r.renamed.get("a")).toBe("a-2");
    expect(r.renamed.has("c")).toBe(false); // 无冲突不改名
    expect(r.skip).toEqual([]);
    expect(r.overwritten).toEqual([]);
  });

  it("rename：批内重复名以首个为准（Map<old,new> 无法表达同名多份）", () => {
    const r = applyImportConflict(["a"], ["a", "a"], "rename");
    expect(r.renamed.size).toBe(1);
    expect(r.renamed.get("a")).toBe("a-1");
  });

  it("overwrite：冲突名进 overwritten", () => {
    const r = applyImportConflict(["a", "b"], ["a", "x"], "overwrite");
    expect(r.overwritten).toEqual(["a"]);
    expect(r.skip).toEqual([]);
    expect(r.renamed.size).toBe(0);
  });

  it("无冲突时三策略均不动", () => {
    for (const strategy of ["skip", "rename", "overwrite"] as const) {
      const r = applyImportConflict(["a"], ["b", "c"], strategy);
      expect(r.skip).toEqual([]);
      expect(r.renamed.size).toBe(0);
      expect(r.overwritten).toEqual([]);
    }
  });
});
