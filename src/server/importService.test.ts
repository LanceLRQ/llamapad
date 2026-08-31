import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BUILTIN_DEFAULT_CONFIG } from "@/core/config";
import type { ModelConfig } from "@/core/schemas";
import { openDb, runMigrations } from "./db";
import { applyDefaults, applyRemap, importModels, importRepos } from "./importService";
import { createModelRepo } from "./repo/models";
import { listProfiles } from "./repoProfiles";

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

describe("importModels 的 remap（T4 导入时重指文件）", () => {
  it("不传 remap 时行为与现状逐字一致（向后兼容锁）", () => {
    const db = freshDb();
    const outcome = importModels(db, [model("m1")], "skip");
    expect(outcome.imported).toEqual(["m1"]);
    expect(createModelRepo(db).getModel("m1")?.gguf_file).toBe("main/m1.gguf");
    db.close();
  });

  it("remap 命中模型名时替换 gguf_file / mmproj_file，落库为新路径", () => {
    const db = freshDb();
    const outcome = importModels(
      db,
      [model("m1", { mmproj_file: "main/m1-mmproj.gguf" })],
      "skip",
      { m1: { gguf_file: "shared/m1-new.gguf", mmproj_file: "shared/m1-mmproj-new.gguf" } },
    );
    expect(outcome.imported).toEqual(["m1"]);
    const saved = createModelRepo(db).getModel("m1");
    expect(saved?.gguf_file).toBe("shared/m1-new.gguf");
    expect(saved?.mmproj_file).toBe("shared/m1-mmproj-new.gguf");
    db.close();
  });

  it("remap 只列出一个字段时，另一个字段保留原值", () => {
    const db = freshDb();
    importModels(db, [model("m1", { mmproj_file: "main/m1-mmproj.gguf" })], "skip", {
      m1: { gguf_file: "shared/m1-new.gguf" },
    });
    const saved = createModelRepo(db).getModel("m1");
    expect(saved?.gguf_file).toBe("shared/m1-new.gguf");
    expect(saved?.mmproj_file).toBe("main/m1-mmproj.gguf");
    db.close();
  });

  it("remap 值不是合法 gguf 路径时抛出带字段路径的错误", () => {
    const db = freshDb();
    expect(() =>
      importModels(db, [model("m1")], "skip", { m1: { gguf_file: "not-a-gguf-path" } }),
    ).toThrow(/remap\.m1\.gguf_file/);
    db.close();
  });

  it("remap 指向不存在的模型名时静默忽略，不影响正常导入", () => {
    const db = freshDb();
    const outcome = importModels(db, [model("m1")], "skip", {
      ghost: { gguf_file: "main/ghost.gguf" },
    });
    expect(outcome.imported).toEqual(["m1"]);
    expect(createModelRepo(db).getModel("m1")?.gguf_file).toBe("main/m1.gguf");
    db.close();
  });
});

describe("applyRemap", () => {
  it("只替换命中模型的字段，未命中的模型原样返回", () => {
    const models = [model("m1"), model("m2")];
    const result = applyRemap(models, { m1: { gguf_file: "shared/x.gguf" } });
    expect(result[0].gguf_file).toBe("shared/x.gguf");
    expect(result[1]).toEqual(models[1]);
  });
});

describe("importRepos", () => {
  // createProfile 真落盘（mkdir + 标记文件），需要一个真实临时目录当 modelsRoot
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "llamapad-import-repos-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("新档案被登记", () => {
    const db = freshDb();
    const outcome = importRepos(db, root, [{ repo: "o/r", baseDir: "hf" }]);
    expect(outcome.imported).toEqual(["hf/o/r"]);
    expect(outcome.skipped).toEqual([]);
    expect(listProfiles(db)).toHaveLength(1);
    db.close();
  });

  it("已登记的同 (baseDir, repo) 走 skipped 且不抛，其余条目正常导入", () => {
    const db = freshDb();
    importRepos(db, root, [{ repo: "o/r", baseDir: "hf" }]);
    const outcome = importRepos(db, root, [
      { repo: "o/r", baseDir: "hf" },
      { repo: "o/r2", baseDir: "hf" },
    ]);
    expect(outcome.imported).toEqual(["hf/o/r2"]);
    expect(outcome.skipped).toEqual(["hf/o/r"]);
    expect(listProfiles(db)).toHaveLength(2);
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
