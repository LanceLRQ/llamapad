import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { BUILTIN_DEFAULT_CONFIG } from "@/core/config";
import type { ModelConfig } from "@/core/schemas";
import { openDb, runMigrations } from "./db";
import { applyDefaults, importModels } from "./importService";
import { createModelRepo } from "./repo/models";

/**
 * 导入服务（M2 Task 8）：import / migrate/bash 两个路由共用的落库逻辑——
 * 命名空间自动补建、冲突三策略（applyImportConflict 纯函数的结果执行）、
 * 默认配置写入。路由层只做 body 校验与 YAML 解析。
 */

function freshDb(): Database.Database {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}

function model(name: string, overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    name,
    display_name: name,
    namespace: "main",
    gguf_file: `main/${name}.gguf`,
    overrides: {},
    ...overrides,
  };
}

describe("importModels", () => {
  it("新名直接入库；缺失命名空间自动补建", () => {
    const db = freshDb();
    const repo = createModelRepo(db);
    const outcome = importModels(db, [model("m1", { namespace: "shared" })], "skip");
    expect(outcome.imported).toEqual(["m1"]);
    expect(repo.getModel("m1")?.namespace).toBe("shared");
    expect(repo.listNamespaces()).toContain("shared");
    db.close();
  });

  it("skip：冲突名跳过，库中原样保留", () => {
    const db = freshDb();
    const repo = createModelRepo(db);
    repo.createModel(model("dup", { display_name: "原有" }));
    const outcome = importModels(
      db,
      [model("dup", { display_name: "导入版" }), model("fresh")],
      "skip",
    );
    expect(outcome.imported).toEqual(["fresh"]);
    expect(outcome.skipped).toEqual(["dup"]);
    expect(repo.getModel("dup")?.display_name).toBe("原有");
    db.close();
  });

  it("rename：冲突名加 -1 落库，原名记录在 renamed", () => {
    const db = freshDb();
    const repo = createModelRepo(db);
    repo.createModel(model("dup"));
    const outcome = importModels(db, [model("dup", { display_name: "改名版" })], "rename");
    expect(outcome.renamed).toEqual([{ from: "dup", to: "dup-1" }]);
    expect(outcome.imported).toEqual(["dup-1"]);
    expect(repo.getModel("dup-1")?.display_name).toBe("改名版");
    db.close();
  });

  it("overwrite：覆盖已有模型的全部可编辑字段", () => {
    const db = freshDb();
    const repo = createModelRepo(db);
    repo.createModel(model("dup", { display_name: "旧", overrides: { server: { temp: 1 } } }));
    const outcome = importModels(
      db,
      [
        model("dup", {
          display_name: "新",
          namespace: "main",
          gguf_file: "main/new.gguf",
          overrides: { server: { top_k: 5 } },
        }),
      ],
      "overwrite",
    );
    expect(outcome.overwritten).toEqual(["dup"]);
    expect(outcome.imported).toEqual(["dup"]);
    const updated = repo.getModel("dup");
    expect(updated?.display_name).toBe("新");
    expect(updated?.gguf_file).toBe("main/new.gguf");
    expect(updated?.overrides).toEqual({ server: { top_k: 5 } });
    db.close();
  });

  it("批内重名（畸形数据）：首个为准，后续丢弃并 warning", () => {
    const db = freshDb();
    const outcome = importModels(
      db,
      [model("twice", { display_name: "第一份" }), model("twice", { display_name: "第二份" })],
      "skip",
    );
    expect(outcome.imported).toEqual(["twice"]);
    expect(outcome.warnings.some((w) => w.includes("twice"))).toBe(true);
    expect(createModelRepo(db).getModel("twice")?.display_name).toBe("第一份");
    db.close();
  });
});

describe("applyDefaults", () => {
  it("写入默认配置（setDefaultConfig 同款校验）", () => {
    const db = freshDb();
    const changed = structuredClone(BUILTIN_DEFAULT_CONFIG);
    changed.server.temp = 0.15;
    applyDefaults(db, changed);
    expect(createModelRepo(db).getDefaultConfig().server.temp).toBe(0.15);
    db.close();
  });

  it("非法默认配置抛 message 带字段路径的 Error", () => {
    const db = freshDb();
    const broken = structuredClone(BUILTIN_DEFAULT_CONFIG);
    broken.docker.host_port = 70000;
    expect(() => applyDefaults(db, broken)).toThrow(/docker\.host_port/);
    db.close();
  });
});
