import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDb, runMigrations } from "../db";
import type { DefaultConfig, ModelConfig } from "../../core/schemas";
import { createModelRepo, type ModelRepo, type StoredModel } from "./models";
import { ModelNameConflictError } from "../modelErrors";

/**
 * 期望的内置默认配置（任务规格给定：bash 前身默认 + llama-server 容器名/宿主机视角卷）。
 * 测试内显式书写，不用实现导出的常量自证。
 */
const EXPECTED_BUILTIN: DefaultConfig = {
  docker: {
    image: "ghcr.io/ggml-org/llama.cpp:server-cuda",
    container_name: "llama-server",
    model_volume: "/srv/llama/models:/models",
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

function makeRepo(): { db: Database.Database; repo: ModelRepo } {
  const db = openDb(":memory:");
  runMigrations(db);
  return { db, repo: createModelRepo(db) };
}

function model(partial: Partial<ModelConfig>): ModelConfig {
  return {
    name: "qwen-7b",
    display_name: "Qwen 7B",
    namespace: "main",
    gguf_file: "main/qwen-7b.gguf",
    overrides: {},
    ...partial,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("命名空间", () => {
  it("repo 初始化时自动创建 main 命名空间，且幂等（重复建 repo 不报错不重复）", () => {
    const { db, repo } = makeRepo();
    expect(repo.listNamespaces()).toContain("main");

    const repo2 = createModelRepo(db);
    expect(repo2.listNamespaces()).toEqual(["main"]);
  });

  it("createNamespace 建立新命名空间（重复调用幂等）", () => {
    const { repo } = makeRepo();
    repo.createNamespace("exp");
    repo.createNamespace("exp");
    expect(repo.listNamespaces()).toEqual(["exp", "main"]);
  });
});

describe("createModel / getModel", () => {
  it("合法 ModelConfig 入库成功，overrides/download JSON 往返一致；时间戳为 ISO 字符串", () => {
    const { repo } = makeRepo();
    const input = model({
      mmproj_file: "main/mmproj-F16.gguf",
      download: {
        source: "hf",
        repo: "Qwen/Qwen3-7B-GGUF",
        file: "Qwen3-7B-Q4_K_M.gguf",
        sha256: "a".repeat(64),
      },
      overrides: { server: { gpu_layers: 5 }, docker: { host_port: 9000 } },
    });

    const created = repo.createModel(input);
    expect(created.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(created.updated_at).toBe(created.created_at);

    const got = repo.getModel("qwen-7b");
    expect(got).not.toBeNull();
    expect(got?.display_name).toBe("Qwen 7B");
    expect(got?.namespace).toBe("main");
    expect(got?.gguf_file).toBe("main/qwen-7b.gguf");
    expect(got?.mmproj_file).toBe("main/mmproj-F16.gguf");
    expect(got?.download).toEqual(input.download);
    expect(got?.overrides).toEqual(input.overrides);
  });

  it("最小模型（无 mmproj/download）可选字段读回 undefined", () => {
    const { repo } = makeRepo();
    repo.createModel(model({}));
    const got = repo.getModel("qwen-7b");
    expect(got?.mmproj_file).toBeUndefined();
    expect(got?.download).toBeUndefined();
    expect(got?.overrides).toEqual({});
  });

  it("重复 name 抛 ModelNameConflictError（而非裸 SqliteError）", () => {
    const { repo } = makeRepo();
    repo.createModel(model({}));
    expect(() => repo.createModel(model({}))).toThrow(ModelNameConflictError);
    try {
      repo.createModel(model({}));
    } catch (error) {
      expect((error as ModelNameConflictError).modelName).toBe("qwen-7b");
      expect((error as Error).message).not.toContain("UNIQUE constraint");
    }
  });

  it("引用不存在的命名空间抛错（外键）", () => {
    const { repo } = makeRepo();
    const ghost = model({ name: "ghost-model", namespace: "ghost", gguf_file: "ghost/x.gguf" });
    expect(() => repo.createModel(ghost)).toThrow(/ghost/);
    expect(repo.listModels()).toHaveLength(0);
  });
});

describe("updateModel / deleteModel / listModels", () => {
  it("updateModel 修改 display_name/overrides 后读取一致，updated_at 变化而 created_at 不变", () => {
    const { repo } = makeRepo();
    vi.spyOn(Date, "now").mockReturnValue(1_000_000_000_000);
    const created = repo.createModel(model({}));

    vi.spyOn(Date, "now").mockReturnValue(1_000_000_060_000);
    const updated = repo.updateModel("qwen-7b", {
      display_name: "Qwen 7B（已调参）",
      overrides: { server: { temp: 0.1 } },
    });

    expect(updated.display_name).toBe("Qwen 7B（已调参）");
    expect(updated.overrides).toEqual({ server: { temp: 0.1 } });
    expect(updated.created_at).toBe(created.created_at);
    expect(updated.updated_at).not.toBe(created.updated_at);

    const got = repo.getModel("qwen-7b");
    expect(got?.display_name).toBe("Qwen 7B（已调参）");
    expect(got?.overrides).toEqual({ server: { temp: 0.1 } });
  });

  it("updateModel 可改 download 配置（换 repo 与文件名，回归填错源不必删了重建）", () => {
    const { repo } = makeRepo();
    repo.createModel(
      model({ download: { source: "hf", repo: "old/repo", file: "a.gguf" } }),
    );

    repo.updateModel("qwen-7b", {
      download: { source: "hf", repo: "new/repo", file: "b.gguf" },
    });

    expect(repo.getModel("qwen-7b")?.download).toEqual({
      source: "hf",
      repo: "new/repo",
      file: "b.gguf",
    });
  });

  it("updateModel 传 download: null 显式清空，DB 列存真正的 NULL 而非字符串", () => {
    const { db, repo } = makeRepo();
    repo.createModel(
      model({ download: { source: "hf", repo: "old/repo", file: "a.gguf" } }),
    );

    repo.updateModel("qwen-7b", { download: null });

    expect(repo.getModel("qwen-7b")?.download).toBeUndefined();
    const row = db
      .prepare("SELECT download FROM models WHERE name = ?")
      .get("qwen-7b") as { download: string | null };
    expect(row.download).toBeNull();
  });

  it("updateModel 不存在的模型抛错", () => {
    const { repo } = makeRepo();
    expect(() => repo.updateModel("no-such", { display_name: "x" })).toThrow(/no-such/);
  });

  it("deleteModel 后 get 返回 null、list 不含", () => {
    const { repo } = makeRepo();
    repo.createModel(model({}));
    repo.deleteModel("qwen-7b");
    expect(repo.getModel("qwen-7b")).toBeNull();
    expect(repo.listModels().map((m: StoredModel) => m.name)).not.toContain("qwen-7b");
  });

  it("listModels 支持按 namespace 过滤", () => {
    const { repo } = makeRepo();
    repo.createNamespace("exp");
    repo.createModel(model({}));
    repo.createModel(model({ name: "exp-llama", display_name: "Llama", namespace: "exp", gguf_file: "exp/llama.gguf" }));

    expect(repo.listModels().map((m) => m.name)).toEqual(["exp-llama", "qwen-7b"]);
    expect(repo.listModels("main").map((m) => m.name)).toEqual(["qwen-7b"]);
    expect(repo.listModels("exp").map((m) => m.name)).toEqual(["exp-llama"]);
  });
});

describe("settings：默认配置读写", () => {
  it("getDefaultConfig 未设置时返回内置默认值（每次独立副本）", () => {
    const { repo } = makeRepo();
    const cfg = repo.getDefaultConfig();
    expect(cfg).toEqual(EXPECTED_BUILTIN);

    // 返回值不与内置常量共享引用：改它不影响后续读取
    cfg.server.temp = 9.9;
    expect(repo.getDefaultConfig().server.temp).toBe(0.7);
  });

  it("setDefaultConfig/getDefaultConfig JSON 往返一致", () => {
    const { repo } = makeRepo();
    const custom: DefaultConfig = {
      docker: { ...EXPECTED_BUILTIN.docker, host_port: 9000, gpu: "device=0,1" },
      server: { ...EXPECTED_BUILTIN.server, gpu_layers: 5, temp: 0.1 },
    };
    repo.setDefaultConfig(custom);
    expect(repo.getDefaultConfig()).toEqual(custom);
  });

  it("setDefaultConfig 存入非法数据时抛出带字段路径的错误", () => {
    const { repo } = makeRepo();
    const invalid = {
      ...EXPECTED_BUILTIN,
      docker: { ...EXPECTED_BUILTIN.docker, host_port: 70000 },
    } as unknown as DefaultConfig;
    expect(() => repo.setDefaultConfig(invalid)).toThrow(/docker\.host_port/);

    // 未写入：读取仍为内置默认
    expect(repo.getDefaultConfig()).toEqual(EXPECTED_BUILTIN);
  });

  it("getDefaultConfig 读到库中损坏 JSON 时抛清晰错误（不静默回退）", () => {
    const { db, repo } = makeRepo();
    db.prepare("INSERT INTO settings(key, value) VALUES ('default_config', ?)").run("{not valid json");
    expect(() => repo.getDefaultConfig()).toThrow(/default_config/);
  });

  it("getDefaultConfig 读到合法 JSON 但不满足 schema 时同样抛错", () => {
    const { db, repo } = makeRepo();
    db.prepare("INSERT INTO settings(key, value) VALUES ('default_config', ?)").run(
      JSON.stringify({ docker: { host_port: 70000 } }),
    );
    expect(() => repo.getDefaultConfig()).toThrow(/host_port/);
  });
});
