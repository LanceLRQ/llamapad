import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, runMigrations } from "./db";
import { createMockDockerAdapter } from "./adapters/mock";
import { createModelRepo, type ModelRepo } from "./repo/models";
import type { ModelConfig } from "../core/schemas";
import { createRuntimeService, type RuntimeService } from "./runtime";
import {
  bulkDeleteFiles,
  deleteFile,
  getFileRefs,
  getFilesTree,
  siblingShards,
  FileApiError,
  type FileRef,
} from "./filesApi";

/**
 * 文件引用扫描与三层删除语义测试（M1 Task 10，TDD）
 *
 * 搭建与 modelsView.test.ts 同款：:memory: 库 + tmp models 根 + mock 适配器 +
 * createRuntimeService（host/panel 根合一）。核心被测对象：
 * - getFileRefs：精确引用 / glob 引用（resolveModelFiles 展开后比对）
 * - deleteFile：REFERENCED（非 force）/ LOCKED（运行中，force 也不放行）/
 *   NOT_FOUND / INVALID_PATH（防逃逸）四类语义
 * - siblingShards：分片组提示（同前缀同 total 的其余分片）
 * - getFilesTree：scanTree + 每文件 refs 计数
 */

interface World {
  db: Database.Database;
  repo: ModelRepo;
  runtime: RuntimeService;
  root: string;
}

let world: World;

/** 在临时 models 根下写一个指定字节数的假文件（父目录自动创建） */
function touch(rel: string, bytes = 1): void {
  const abs = path.join(world.root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, Buffer.alloc(bytes, "x"));
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

function refs(relPath: string): FileRef[] {
  return getFileRefs(world.db, world.root, relPath);
}

/** 断言抛 FileApiError 且 code 匹配（返回捕获的错误便于继续断言 message） */
async function expectCode(fn: () => unknown | Promise<unknown>, code: string): Promise<FileApiError> {
  let caught: unknown;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(FileApiError);
  const err = caught as FileApiError;
  expect(err.code).toBe(code);
  return err;
}

beforeEach(() => {
  const db = openDb(":memory:");
  runMigrations(db);
  const root = mkdtempSync(path.join(tmpdir(), "llamapad-filesApi-"));
  world = {
    db,
    repo: createModelRepo(db),
    runtime: createRuntimeService(db, createMockDockerAdapter(), root, root),
    root,
  };
});

afterEach(() => {
  world.db.close();
  rmSync(world.root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- getFileRefs

describe("getFileRefs：精确引用", () => {
  it("gguf_file === relPath → 引用（field=gguf_file）", () => {
    addModel({ name: "m1", gguf_file: "main/a.gguf" });

    const r = refs("main/a.gguf");
    expect(r).toEqual([{ modelName: "m1", field: "gguf_file" }]);
  });

  it("mmproj_file === relPath → 引用（field=mmproj_file，与 gguf 区分）", () => {
    addModel({ name: "m1", gguf_file: "main/a.gguf", mmproj_file: "main/a-mm.gguf" });

    expect(refs("main/a-mm.gguf")).toEqual([{ modelName: "m1", field: "mmproj_file" }]);
    expect(refs("main/a.gguf")).toEqual([{ modelName: "m1", field: "gguf_file" }]);
  });

  it("同一文件被两个模型的同一字段引用 → 两条引用（多配置一等场景）", () => {
    addModel({ name: "m1", gguf_file: "main/shared.gguf" });
    addModel({ name: "m2", gguf_file: "main/shared.gguf" });

    expect(refs("main/shared.gguf")).toHaveLength(2);
    expect(refs("main/shared.gguf").map((r) => r.modelName).sort()).toEqual(["m1", "m2"]);
  });

  it("无引用 → 空数组", () => {
    addModel({ name: "m1", gguf_file: "main/a.gguf" });

    expect(refs("main/other.gguf")).toEqual([]);
  });
});

describe("getFileRefs：glob 引用（配置写 glob、磁盘是具体分片）", () => {
  beforeEach(() => {
    touch("main/qwen-00001-of-00002.gguf", 10);
    touch("main/qwen-00002-of-00002.gguf", 20);
    addModel({ name: "glob-model", gguf_file: "main/qwen-*.gguf" });
  });

  it("查具体分片的引用 → 命中 glob 配置的模型（展开后包含）", () => {
    const r = refs("main/qwen-00001-of-00002.gguf");
    expect(r).toEqual([{ modelName: "glob-model", field: "gguf_file" }]);

    expect(refs("main/qwen-00002-of-00002.gguf")).toEqual([
      { modelName: "glob-model", field: "gguf_file" },
    ]);
  });

  it("查同命名空间其他文件 → 不命中", () => {
    expect(refs("main/other.gguf")).toEqual([]);
  });

  it("glob mmproj 同样展开比对", () => {
    touch("main/mm-1.gguf", 5);
    touch("main/mm-2.gguf", 5);
    addModel({ name: "mm-glob", gguf_file: "main/a.gguf", mmproj_file: "main/mm-?.gguf" });

    expect(refs("main/mm-2.gguf")).toEqual([{ modelName: "mm-glob", field: "mmproj_file" }]);
  });

  it("精确 + glob 两种配置同时引用同一文件 → 两条引用", () => {
    addModel({ name: "exact-model", gguf_file: "main/qwen-00001-of-00002.gguf" });

    const r = refs("main/qwen-00001-of-00002.gguf");
    expect(r).toHaveLength(2);
    expect(r.map((x) => x.modelName).sort()).toEqual(["exact-model", "glob-model"]);
  });

  it("glob 零命中（磁盘无匹配文件）→ 不产生引用", () => {
    addModel({ name: "no-hit", gguf_file: "main/zzz-*.gguf" });

    expect(refs("main/qwen-00001-of-00002.gguf")).toEqual([
      { modelName: "glob-model", field: "gguf_file" },
    ]);
  });
});

describe("getFileRefs：路径安全", () => {
  it("含 .. → INVALID_PATH", () => {
    expect(() => refs("../etc/passwd")).toThrow(FileApiError);
    expect(() => refs("main/../../etc/passwd")).toThrow(/INVALID_PATH/);
  });

  it("绝对路径 → INVALID_PATH", () => {
    expect(() => refs("/etc/passwd")).toThrow(/INVALID_PATH/);
  });
});

// ----------------------------------------------------------------- deleteFile

describe("deleteFile：REFERENCED / LOCKED / 删除 / NOT_FOUND", () => {
  it("refs 非空且未 force → REFERENCED，message 含 code 与引用模型名", async () => {
    const refList: FileRef[] = [
      { modelName: "m1", field: "gguf_file" },
      { modelName: "m2", field: "gguf_file" },
    ];
    touch("main/a.gguf", 10);

    const err = await expectCode(
      () => deleteFile(world.root, "main/a.gguf", { refs: refList, runningModel: null }),
      "REFERENCED",
    );
    expect(err.message).toContain("m1");
    expect(err.message).toContain("m2");
    expect(err.refs).toEqual(refList);
    // 未 force：文件保留
    expect(existsSync(path.join(world.root, "main/a.gguf"))).toBe(true);
  });

  it("refs 含当前运行模型 → 无论 force 一律 LOCKED", async () => {
    touch("main/run.gguf", 10);
    touch("main/victim.gguf", 10);
    addModel({ name: "run-me", gguf_file: "main/run.gguf" });
    addModel({ name: "holder", gguf_file: "main/victim.gguf" });
    await world.runtime.startModel("run-me");

    const refList = refs("main/victim.gguf");
    expect(refList).toEqual([{ modelName: "holder", field: "gguf_file" }]);

    // victim 不被运行模型引用：force 可删
    await deleteFile(world.root, "main/victim.gguf", { refs: refList, runningModel: "run-me", force: true });
    expect(existsSync(path.join(world.root, "main/victim.gguf"))).toBe(false);

    // 换成运行模型自己引用的文件：refs 命中 run-me → force 也不放行
    touch("main/victim.gguf", 10);
    const lockedRefs = refs("main/run.gguf");
    expect(lockedRefs).toEqual([{ modelName: "run-me", field: "gguf_file" }]);
    await expectCode(
      () =>
        deleteFile(world.root, "main/run.gguf", { refs: lockedRefs, runningModel: "run-me", force: true }),
      "LOCKED",
    );
    expect(existsSync(path.join(world.root, "main/run.gguf"))).toBe(true);
  });

  it("无引用 → 真删文件，返回删除列表", async () => {
    touch("main/free.gguf", 10);

    const result = await deleteFile(world.root, "main/free.gguf", {
      refs: [],
      runningModel: null,
    });
    expect(result.deleted).toEqual(["main/free.gguf"]);
    expect(existsSync(path.join(world.root, "main/free.gguf"))).toBe(false);
  });

  it("refs 非空但 force（且非运行中）→ 删除", async () => {
    touch("main/a.gguf", 10);

    await deleteFile(world.root, "main/a.gguf", {
      refs: [{ modelName: "m1", field: "gguf_file" }],
      runningModel: null,
      force: true,
    });
    expect(existsSync(path.join(world.root, "main/a.gguf"))).toBe(false);
  });

  it("文件不存在 → NOT_FOUND", async () => {
    await expectCode(
      () => deleteFile(world.root, "main/nope.gguf", { refs: [], runningModel: null }),
      "NOT_FOUND",
    );
  });

  it("glob 模式删除：展开后全删（零命中 → NOT_FOUND）", async () => {
    touch("main/s-00001-of-00002.gguf", 10);
    touch("main/s-00002-of-00002.gguf", 20);
    touch("main/other.gguf", 5);

    const result = await deleteFile(world.root, "main/s-*.gguf", {
      refs: [],
      runningModel: null,
    });
    expect(result.deleted.sort()).toEqual([
      "main/s-00001-of-00002.gguf",
      "main/s-00002-of-00002.gguf",
    ]);
    expect(existsSync(path.join(world.root, "main/other.gguf"))).toBe(true);

    await expectCode(
      () => deleteFile(world.root, "main/s-*.gguf", { refs: [], runningModel: null }),
      "NOT_FOUND",
    );
  });
});

describe("deleteFile：安全（防逃逸 models 根）", () => {
  it("relPath 含 .. → INVALID_PATH，不触碰根外文件", async () => {
    touch("outside.txt", 3);
    const outsideAbs = path.join(world.root, "outside.txt");

    await expectCode(
      () => deleteFile(world.root, "../outside.txt", { refs: [], runningModel: null }),
      "INVALID_PATH",
    );
    // resolve(root, "../outside.txt") 恰好是根下文件的逃逸探针：文件必须仍在
    expect(existsSync(outsideAbs)).toBe(true);
  });

  it("main/../../x 形式 → INVALID_PATH", async () => {
    await expectCode(
      () => deleteFile(world.root, "main/../../etc/passwd", { refs: [], runningModel: null }),
      "INVALID_PATH",
    );
  });

  it("绝对路径 → INVALID_PATH", async () => {
    await expectCode(
      () => deleteFile(world.root, "/etc/passwd", { refs: [], runningModel: null }),
      "INVALID_PATH",
    );
  });
});

// --------------------------------------------------------------- siblingShards

describe("siblingShards（分片组提示，不自动删组）", () => {
  it("同前缀同 total 的其余分片（排除自身），按名称排序", () => {
    touch("main/qwen-00001-of-00003.gguf", 1);
    touch("main/qwen-00002-of-00003.gguf", 1);
    touch("main/qwen-00003-of-00003.gguf", 1);
    touch("main/qwen-00001-of-00002.gguf", 1); // total 不同，不同组
    touch("main/qwen-mini.gguf", 1); // 非分片命名

    expect(siblingShards(world.root, "main/qwen-00001-of-00003.gguf")).toEqual([
      "main/qwen-00002-of-00003.gguf",
      "main/qwen-00003-of-00003.gguf",
    ]);
  });

  it("量化后缀形态（-00001-of-00002.Q8_0.gguf）同组识别", () => {
    touch("main/m-00001-of-00002.Q8_0.gguf", 1);
    touch("main/m-00002-of-00002.Q8_0.gguf", 1);

    expect(siblingShards(world.root, "main/m-00001-of-00002.Q8_0.gguf")).toEqual([
      "main/m-00002-of-00002.Q8_0.gguf",
    ]);
  });

  it("非分片命名 / total=1 / 不存在 → 空数组", () => {
    touch("main/plain.gguf", 1);
    touch("main/solo-00001-of-00001.gguf", 1);

    expect(siblingShards(world.root, "main/plain.gguf")).toEqual([]);
    expect(siblingShards(world.root, "main/solo-00001-of-00001.gguf")).toEqual([]);
    expect(siblingShards(world.root, "main/gone-00001-of-00002.gguf")).toEqual([]);
  });
});

// ----------------------------------------------------------------- getFilesTree

describe("getFilesTree：scanTree + 每文件 refs 计数", () => {
  it("各文件 refs 数正确，未引用为 0", () => {
    touch("main/a.gguf", 10);
    touch("main/b.gguf", 20);
    touch("ns2/c.gguf", 30);
    world.repo.createNamespace("ns2");
    addModel({ name: "m1", gguf_file: "main/a.gguf" });
    addModel({ name: "m2", gguf_file: "main/a.gguf" });
    addModel({ name: "m3", gguf_file: "main/b.gguf" });

    const tree = getFilesTree(world.db, world.root);
    expect(tree.map((ns) => ns.namespace)).toEqual(["main", "ns2"]);

    const main = tree[0];
    expect(main.files.map((f) => [f.rel, f.refs])).toEqual([
      ["main/a.gguf", 2],
      ["main/b.gguf", 1],
    ]);
    expect(main.files[0]).toMatchObject({ size: 10 });
    expect(main.files[0].mtime).toBeGreaterThan(0);

    const ns2 = tree[1];
    expect(ns2.files.map((f) => [f.rel, f.refs])).toEqual([["ns2/c.gguf", 0]]);
  });

  it("glob 引用在 tree 计数中同样命中", () => {
    touch("main/q-00001-of-00002.gguf", 1);
    touch("main/q-00002-of-00002.gguf", 1);
    addModel({ name: "glob-model", gguf_file: "main/q-*.gguf" });

    const tree = getFilesTree(world.db, world.root);
    const files = tree[0].files;
    expect(files.every((f) => f.refs === 1)).toBe(true);
    expect(files).toHaveLength(2);
  });
});

// -------------------------------------------------------------- bulkDeleteFiles

describe("bulkDeleteFiles：批量编排（U21，逐个走 getFileRefs + deleteFile 三态归类）", () => {
  it("分类返回：无引用删除 / 被引用未 force 跳过 referenced / 被锁定跳过 locked / 不存在跳过 notFound", async () => {
    touch("main/free.gguf", 10);
    touch("main/ref.gguf", 10);
    touch("main/run.gguf", 10);
    addModel({ name: "ref-model", gguf_file: "main/ref.gguf" });
    addModel({ name: "run-me", gguf_file: "main/run.gguf" });
    await world.runtime.startModel("run-me");

    const result = await bulkDeleteFiles(
      world.db,
      world.root,
      ["main/free.gguf", "main/ref.gguf", "main/run.gguf", "main/missing.gguf"],
      { runningModel: "run-me" },
    );

    expect(result.deleted).toEqual(["main/free.gguf"]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { path: "main/ref.gguf", reason: "referenced" },
        { path: "main/run.gguf", reason: "locked" },
        { path: "main/missing.gguf", reason: "notFound" },
      ]),
    );
    expect(result.skipped).toHaveLength(3);
    expect(existsSync(path.join(world.root, "main/free.gguf"))).toBe(false);
    expect(existsSync(path.join(world.root, "main/ref.gguf"))).toBe(true);
    expect(existsSync(path.join(world.root, "main/run.gguf"))).toBe(true);
  });

  it("force=true 放行 REFERENCED，但 LOCKED 依旧跳过（风险簿第 8 条：force 也不放行）", async () => {
    touch("main/ref.gguf", 10);
    touch("main/run.gguf", 10);
    addModel({ name: "ref-model", gguf_file: "main/ref.gguf" });
    addModel({ name: "run-me", gguf_file: "main/run.gguf" });
    await world.runtime.startModel("run-me");

    const result = await bulkDeleteFiles(world.db, world.root, ["main/ref.gguf", "main/run.gguf"], {
      runningModel: "run-me",
      force: true,
    });

    expect(result.deleted).toEqual(["main/ref.gguf"]);
    expect(result.skipped).toEqual([{ path: "main/run.gguf", reason: "locked" }]);
    expect(existsSync(path.join(world.root, "main/ref.gguf"))).toBe(false);
    expect(existsSync(path.join(world.root, "main/run.gguf"))).toBe(true);
  });

  it("无引用无锁定：全部删除，deleted 顺序与传入一致", async () => {
    touch("main/a.gguf", 10);
    touch("main/b.gguf", 10);

    const result = await bulkDeleteFiles(world.db, world.root, ["main/a.gguf", "main/b.gguf"], {
      runningModel: null,
    });

    expect(result.deleted).toEqual(["main/a.gguf", "main/b.gguf"]);
    expect(result.skipped).toEqual([]);
  });

  it("路径非法（含 ..）→ 抛 FileApiError INVALID_PATH，已处理的合法路径不回滚（unlink 不可逆）", async () => {
    touch("main/before.gguf", 10);

    await expectCode(
      () =>
        bulkDeleteFiles(world.db, world.root, ["main/before.gguf", "../etc/passwd"], {
          runningModel: null,
        }),
      "INVALID_PATH",
    );
    expect(existsSync(path.join(world.root, "main/before.gguf"))).toBe(false);
  });
});
