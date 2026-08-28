import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, runMigrations } from "./db";
import { createModelRepo, type ModelRepo } from "./repo/models";
import type { ModelConfig } from "../core/schemas";
import { FileMoveError, moveFiles } from "./fileMove";

/**
 * fileMove.moveFiles 原语测试（设计 §2.1，T1 TDD）。
 *
 * 只测原语本身的机制：rename + 事务批量重写，不涉及 LOCKED / REFERENCED
 * 之类的交互确认（那些由调用方在拿到 plan 前完成，回归覆盖见
 * namespaces.test.ts 的 moveModel 用例）。
 */

interface World {
  db: Database.Database;
  repo: ModelRepo;
  root: string;
}

let world: World;

/** 在临时根下写一个指定字节数的假文件（父目录自动创建），返回绝对路径 */
function touch(rel: string, bytes = 1): string {
  const abs = path.join(world.root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, Buffer.alloc(bytes, "x"));
  return abs;
}

function abs(rel: string): string {
  return path.join(world.root, rel);
}

/** 建模型（display_name/namespace/overrides 缺省取最小合法值） */
function addModel(partial: Partial<ModelConfig> & { name: string }): void {
  world.repo.createModel({
    display_name: partial.name,
    namespace: "main",
    gguf_file: "main/a.gguf",
    overrides: {},
    ...partial,
  });
}

beforeEach(() => {
  const db = openDb(":memory:");
  runMigrations(db);
  const root = mkdtempSync(path.join(tmpdir(), "llamapad-filemove-"));
  world = { db, repo: createModelRepo(db), root };
});

afterEach(() => {
  world.db.close();
  rmSync(world.root, { recursive: true, force: true });
});

describe("moveFiles", () => {
  it("单文件 rename 成功 + 引用重写：目标存在、源消失、DB 更新", () => {
    addModel({ name: "m1", gguf_file: "main/m1.gguf" });
    const from = touch("main/m1.gguf", 10);
    const to = abs("lab/m1.gguf");
    mkdirSync(path.dirname(to), { recursive: true });

    const result = moveFiles(
      { db: world.db },
      {
        from: [from],
        to: [to],
        refUpdates: [{ modelName: "m1", field: "gguf_file", nextValue: "lab/m1.gguf" }],
      },
    );

    expect(result.moved).toBe(1);
    expect(existsSync(from)).toBe(false);
    expect(existsSync(to)).toBe(true);
    expect(world.repo.getModel("m1")?.gguf_file).toBe("lab/m1.gguf");
  });

  it("一个文件被 2 个模型引用：移动后两个模型的配置都更新（缺陷回归锁）", () => {
    // qwen3.6 mmproj 场景的最小复现：同一物理文件被两个模型的 mmproj_file 引用
    addModel({ name: "m1", gguf_file: "main/m1.gguf", mmproj_file: "main/shared-mmproj.gguf" });
    addModel({ name: "m2", gguf_file: "main/m2.gguf", mmproj_file: "main/shared-mmproj.gguf" });
    const from = touch("main/shared-mmproj.gguf", 10);
    const to = abs("lab/shared-mmproj.gguf");
    mkdirSync(path.dirname(to), { recursive: true });

    moveFiles(
      { db: world.db },
      {
        from: [from],
        to: [to],
        refUpdates: [
          { modelName: "m1", field: "mmproj_file", nextValue: "lab/shared-mmproj.gguf" },
          { modelName: "m2", field: "mmproj_file", nextValue: "lab/shared-mmproj.gguf" },
        ],
      },
    );

    expect(world.repo.getModel("m1")?.mmproj_file).toBe("lab/shared-mmproj.gguf");
    expect(world.repo.getModel("m2")?.mmproj_file).toBe("lab/shared-mmproj.gguf");
  });

  it("同一模型的 namespace 与路径字段在同一事务内一起改写", () => {
    world.repo.createNamespace("lab");
    addModel({ name: "m1", namespace: "main", gguf_file: "main/m1.gguf" });
    const from = touch("main/m1.gguf", 10);
    const to = abs("lab/m1.gguf");
    mkdirSync(path.dirname(to), { recursive: true });

    moveFiles(
      { db: world.db },
      {
        from: [from],
        to: [to],
        refUpdates: [
          { modelName: "m1", field: "namespace", nextValue: "lab" },
          { modelName: "m1", field: "gguf_file", nextValue: "lab/m1.gguf" },
        ],
      },
    );

    const updated = world.repo.getModel("m1");
    expect(updated?.namespace).toBe("lab");
    expect(updated?.gguf_file).toBe("lab/m1.gguf");
  });

  it("事务原子性：引用重写中途抛错时无部分更新（rename 仍已完成）", () => {
    addModel({ name: "m1", gguf_file: "main/m1.gguf" });
    const from = touch("main/m1.gguf", 10);
    const to = abs("lab/m1.gguf");
    mkdirSync(path.dirname(to), { recursive: true });

    let caught: unknown;
    try {
      moveFiles(
        { db: world.db },
        {
          from: [from],
          to: [to],
          refUpdates: [
            // 第一条正常，第二条指向不存在的模型 → repo.updateModel 抛错，
            // 整个事务应回滚，第一条也不能生效
            { modelName: "m1", field: "gguf_file", nextValue: "lab/m1.gguf" },
            { modelName: "ghost", field: "gguf_file", nextValue: "lab/ghost.gguf" },
          ],
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(FileMoveError);
    expect((caught as FileMoveError).message).toContain("文件已移动");
    expect((caught as FileMoveError).message).toContain("配置未更新");
    // rename 已经完成（不做自动回滚补偿）
    expect(existsSync(from)).toBe(false);
    expect(existsSync(to)).toBe(true);
    // 但 DB 一处都没改——m1 的 gguf_file 仍是移动前的值
    expect(world.repo.getModel("m1")?.gguf_file).toBe("main/m1.gguf");
  });

  it("from/to 长度不一致时直接抛错，不做任何 rename", () => {
    addModel({ name: "m1", gguf_file: "main/m1.gguf" });
    const from = touch("main/m1.gguf", 10);

    expect(() =>
      moveFiles(
        { db: world.db },
        { from: [from], to: [], refUpdates: [] },
      ),
    ).toThrow();
    expect(existsSync(from)).toBe(true);
  });

  it("多文件按下标一一对应移动", () => {
    addModel({ name: "m1", gguf_file: "main/m1-00001-of-00002.gguf" });
    const from1 = touch("main/m1-00001-of-00002.gguf", 10);
    const from2 = touch("main/m1-00002-of-00002.gguf", 20);
    const to1 = abs("lab/m1-00001-of-00002.gguf");
    const to2 = abs("lab/m1-00002-of-00002.gguf");
    mkdirSync(path.dirname(to1), { recursive: true });

    const result = moveFiles(
      { db: world.db },
      {
        from: [from1, from2],
        to: [to1, to2],
        refUpdates: [{ modelName: "m1", field: "gguf_file", nextValue: "lab/m1-*.gguf" }],
      },
    );

    expect(result.moved).toBe(2);
    expect(existsSync(to1)).toBe(true);
    expect(existsSync(to2)).toBe(true);
    expect(world.repo.getModel("m1")?.gguf_file).toBe("lab/m1-*.gguf");
  });
});
