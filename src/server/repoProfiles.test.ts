import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, runMigrations } from "./db";
import { createModelRepo, type ModelRepo } from "./repo/models";
import type { ModelConfig } from "../core/schemas";
import type { FolderFiles } from "./fsScanner";
import {
  createProfile,
  decorateProfileStats,
  deleteProfile,
  listProfiles,
  moveProfile,
  RepoProfileError,
  scanRepoMarkers,
  REPO_MARKER_FILENAME,
  type RepoProfile,
} from "./repoProfiles";

/**
 * 仓库档案服务层测试（批 1，TDD）。
 *
 * 与 folders.test.ts 同款搭台：临时 models 根 + 内存 db，runningModel 直接以
 * 字符串塞进 deps —— LOCKED 判定只需要「当前运行的是哪个模型」，不必搭
 * mock docker 适配器。
 */

interface World {
  db: Database.Database;
  repo: ModelRepo;
  root: string;
}

let world: World;

function touch(rel: string, bytes = 1): void {
  const abs = path.join(world.root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, Buffer.alloc(bytes, "x"));
}

function addModel(partial: Partial<ModelConfig> & { name: string }): void {
  world.repo.createModel({
    display_name: partial.name,
    namespace: "main",
    gguf_file: partial.gguf_file ?? "main/x.gguf",
    overrides: {},
    ...partial,
  } as ModelConfig);
}

function deps(runningModel: string | null = null) {
  return { db: world.db, modelsRoot: world.root, hostRoot: world.root, runningModel };
}

beforeEach(() => {
  const root = mkdtempSync(path.join(tmpdir(), "llamapad-repos-"));
  const db = openDb(":memory:");
  runMigrations(db);
  world = { db, repo: createModelRepo(db), root };
});

afterEach(() => {
  world.db.close();
  rmSync(world.root, { recursive: true, force: true });
});

describe("createProfile", () => {
  it("建出目录、写入标记文件、落 DB 行", () => {
    const p = createProfile(deps(), { repo: "unsloth/Qwen3.5-4B-GGUF", baseDir: "hf" });
    expect(p.targetDir).toBe("hf/unsloth/Qwen3.5-4B-GGUF");
    expect(existsSync(path.join(world.root, p.targetDir))).toBe(true);
    const marker = path.join(world.root, p.targetDir, REPO_MARKER_FILENAME);
    expect(JSON.parse(readFileSync(marker, "utf8")).repo).toBe("unsloth/Qwen3.5-4B-GGUF");
    expect(listProfiles(world.db)).toHaveLength(1);
  });

  it("base 为空串时落在 models 根下", () => {
    const p = createProfile(deps(), { repo: "o/r", baseDir: "" });
    expect(p.targetDir).toBe("o/r");
  });

  it("同 base 同 repo 重复创建报 CONFLICT", () => {
    createProfile(deps(), { repo: "o/r", baseDir: "hf" });
    expect(() => createProfile(deps(), { repo: "o/r", baseDir: "hf" })).toThrow(RepoProfileError);
  });

  it("同 repo 不同 base 允许并存", () => {
    createProfile(deps(), { repo: "o/r", baseDir: "hf" });
    expect(() => createProfile(deps(), { repo: "o/r", baseDir: "qwen3.8" })).not.toThrow();
  });

  it("目录已存在且有标记文件时直接认领，不报错", () => {
    touch(`hf/o/r/${REPO_MARKER_FILENAME}`);
    writeFileSync(
      path.join(world.root, "hf/o/r", REPO_MARKER_FILENAME),
      JSON.stringify({ repo: "o/r", createdAt: 1 }),
    );
    const p = createProfile(deps(), { repo: "o/r", baseDir: "hf" });
    expect(p.claimed).toBe(true);
  });

  it("目录已存在但没有标记文件时也认领并补写标记——多级路径巧合概率为零", () => {
    touch("hf/o/r/model.gguf");
    const p = createProfile(deps(), { repo: "o/r", baseDir: "hf" });
    expect(p.claimed).toBe(true);
    expect(existsSync(path.join(world.root, "hf/o/r", REPO_MARKER_FILENAME))).toBe(true);
  });

  it("非法 repo 报 INVALID_NAME", () => {
    expect(() => createProfile(deps(), { repo: "../etc", baseDir: "hf" })).toThrow(
      /INVALID_NAME/,
    );
  });

  it("非法 base 报 INVALID_NAME", () => {
    expect(() => createProfile(deps(), { repo: "o/r", baseDir: "../x" })).toThrow(/INVALID_NAME/);
  });
});

describe("scanRepoMarkers", () => {
  it("扫出所有带标记文件的目录", () => {
    createProfile(deps(), { repo: "o/r1", baseDir: "hf" });
    createProfile(deps(), { repo: "o/r2", baseDir: "qwen3.8" });
    const found = scanRepoMarkers(world.root);
    expect(found.map((f) => f.dir).sort()).toEqual(["hf/o/r1", "qwen3.8/o/r2"]);
  });

  it("普通目录不会被误认为档案", () => {
    touch("main/a.gguf");
    expect(scanRepoMarkers(world.root)).toEqual([]);
  });
});

describe("deleteProfile", () => {
  it("默认只删 DB 行与标记文件，磁盘文件保留", () => {
    const p = createProfile(deps(), { repo: "o/r", baseDir: "hf" });
    touch("hf/o/r/a.gguf");
    deleteProfile(deps(), { id: p.id, deleteFiles: false });
    expect(listProfiles(world.db)).toHaveLength(0);
    expect(existsSync(path.join(world.root, "hf/o/r/a.gguf"))).toBe(true);
    expect(existsSync(path.join(world.root, "hf/o/r", REPO_MARKER_FILENAME))).toBe(false);
  });

  it("deleteFiles 时递归删掉整个目录", () => {
    const p = createProfile(deps(), { repo: "o/r", baseDir: "hf" });
    touch("hf/o/r/a.gguf");
    deleteProfile(deps(), { id: p.id, deleteFiles: true });
    expect(existsSync(path.join(world.root, "hf/o/r"))).toBe(false);
  });

  it("目录内文件被模型引用时 deleteFiles 报 LOCKED 并列出配置名", () => {
    const p = createProfile(deps(), { repo: "o/r", baseDir: "hf" });
    touch("hf/o/r/a.gguf");
    addModel({ name: "m1", gguf_file: "hf/o/r/a.gguf" });
    try {
      deleteProfile(deps(), { id: p.id, deleteFiles: true });
      throw new Error("应该抛错");
    } catch (error) {
      expect(error).toBeInstanceOf(RepoProfileError);
      expect((error as RepoProfileError).message).toContain("m1");
    }
  });

  it("不存在的 id 报 NOT_FOUND", () => {
    expect(() => deleteProfile(deps(), { id: 999, deleteFiles: false })).toThrow(/NOT_FOUND/);
  });
});

describe("moveProfile", () => {
  it("整目录搬到新 base，引用同步重写", () => {
    const p = createProfile(deps(), { repo: "o/r", baseDir: "hf" });
    touch("hf/o/r/a.gguf");
    addModel({ name: "m1", gguf_file: "hf/o/r/a.gguf" });
    moveProfile(deps(), { id: p.id, toBaseDir: "qwen3.8" });
    expect(existsSync(path.join(world.root, "qwen3.8/o/r/a.gguf"))).toBe(true);
    expect(world.repo.getModel("m1")?.gguf_file).toBe("qwen3.8/o/r/a.gguf");
    expect(listProfiles(world.db)[0].baseDir).toBe("qwen3.8");
  });

  it("运行中模型引用了目录内文件时报 LOCKED", () => {
    const p = createProfile(deps(), { repo: "o/r", baseDir: "hf" });
    touch("hf/o/r/a.gguf");
    addModel({ name: "m1", gguf_file: "hf/o/r/a.gguf" });
    expect(() => moveProfile(deps("m1"), { id: p.id, toBaseDir: "qwen3.8" })).toThrow(/LOCKED/);
  });
});

describe("decorateProfileStats", () => {
  const profile: RepoProfile = {
    id: 1,
    repo: "o/r",
    baseDir: "hf",
    targetDir: "hf/o/r",
    createdAt: 0,
  };

  it("目录及子目录内的文件都计入 fileCount/bytes，目录存在时 dirExists 为真", () => {
    const tree: FolderFiles[] = [
      { folder: "hf/o/r", files: [{ rel: "hf/o/r/a.gguf", size: 100, mtime: 0 }] },
      { folder: "hf/o/r/sub", files: [{ rel: "hf/o/r/sub/b.gguf", size: 50, mtime: 0 }] },
      { folder: "other", files: [{ rel: "other/c.gguf", size: 999, mtime: 0 }] },
    ];
    const [stats] = decorateProfileStats([profile], tree);
    expect(stats.fileCount).toBe(2);
    expect(stats.bytes).toBe(150);
    expect(stats.dirExists).toBe(true);
  });

  it("扫盘结果里没有该目录时 dirExists 为假、fileCount/bytes 为 0", () => {
    const [stats] = decorateProfileStats([profile], []);
    expect(stats.fileCount).toBe(0);
    expect(stats.bytes).toBe(0);
    expect(stats.dirExists).toBe(false);
  });

  it("目录存在但为空（scanTree 仍会给一条 files 为空的记录）时 dirExists 为真", () => {
    const tree: FolderFiles[] = [{ folder: "hf/o/r", files: [] }];
    const [stats] = decorateProfileStats([profile], tree);
    expect(stats.fileCount).toBe(0);
    expect(stats.dirExists).toBe(true);
  });

  it("不会把同名前缀但不是子目录的文件夹算进去（hf/o/r-other 不是 hf/o/r 的子目录）", () => {
    const tree: FolderFiles[] = [
      { folder: "hf/o/r-other", files: [{ rel: "hf/o/r-other/x.gguf", size: 10, mtime: 0 }] },
    ];
    const [stats] = decorateProfileStats([profile], tree);
    expect(stats.fileCount).toBe(0);
    expect(stats.dirExists).toBe(false);
  });
});
