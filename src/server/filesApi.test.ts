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
  planFileMove,
  planFileRename,
  siblingShards,
  FileApiError,
  FileMoveGuardError,
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

// ---------------------------------------------------------------- planFileMove / planFileRename

/** 断言抛 FileMoveGuardError 且 code 匹配（对齐 expectCode 的用法，另建一份因错误类不同） */
function expectGuardCode(fn: () => unknown, code: string): FileMoveGuardError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(FileMoveGuardError);
  const err = caught as FileMoveGuardError;
  expect(err.code).toBe(code);
  return err;
}

describe("planFileMove：移动计划（分片组整组升级、引用重写、守卫顺序）", () => {
  it("单文件移动：命名空间段替换，精确引用同步重写", () => {
    touch("main/a.gguf", 10);
    addModel({ name: "m1", gguf_file: "main/a.gguf" });
    world.repo.createNamespace("shared");

    const plan = planFileMove(world.db, world.root, null, { from: "main/a.gguf", toNamespace: "shared" });

    expect(plan.fromRels).toEqual(["main/a.gguf"]);
    expect(plan.toRels).toEqual(["shared/a.gguf"]);
    expect(plan.refChanges).toEqual([
      { modelName: "m1", field: "gguf_file", from: "main/a.gguf", to: "shared/a.gguf" },
    ]);
    expect(plan.refUpdates).toEqual([{ modelName: "m1", field: "gguf_file", nextValue: "shared/a.gguf" }]);
  });

  it("分片组移动：选中末片自动升级为整组，glob 引用只换命名空间段", () => {
    touch("main/qwen-00001-of-00002.gguf", 10);
    touch("main/qwen-00002-of-00002.gguf", 20);
    addModel({ name: "glob-model", gguf_file: "main/qwen-*.gguf" });
    world.repo.createNamespace("shared");

    const plan = planFileMove(world.db, world.root, null, {
      from: "main/qwen-00002-of-00002.gguf", // 选中末片而非首片
      toNamespace: "shared",
    });

    expect([...plan.fromRels].sort()).toEqual([
      "main/qwen-00001-of-00002.gguf",
      "main/qwen-00002-of-00002.gguf",
    ]);
    expect([...plan.toRels].sort()).toEqual([
      "shared/qwen-00001-of-00002.gguf",
      "shared/qwen-00002-of-00002.gguf",
    ]);
    // glob 引用只登记一次（两个物理文件都命中同一个模型字段，不重复写两条）
    expect(plan.refChanges).toEqual([
      { modelName: "glob-model", field: "gguf_file", from: "main/qwen-*.gguf", to: "shared/qwen-*.gguf" },
    ]);
  });

  it("共享引用：两个模型引用同一文件，移动后两个模型的引用都重写（§1.1 缺陷回归锁）", () => {
    touch("main/shared.gguf", 10);
    touch("main/other.gguf", 10);
    addModel({ name: "m1", gguf_file: "main/shared.gguf" });
    addModel({ name: "m2", gguf_file: "main/other.gguf", mmproj_file: "main/shared.gguf" });
    world.repo.createNamespace("dest");

    const plan = planFileMove(world.db, world.root, null, { from: "main/shared.gguf", toNamespace: "dest" });

    expect(plan.refChanges).toEqual([
      { modelName: "m1", field: "gguf_file", from: "main/shared.gguf", to: "dest/shared.gguf" },
      { modelName: "m2", field: "mmproj_file", from: "main/shared.gguf", to: "dest/shared.gguf" },
    ]);
  });

  it("引用中含运行中模型 → LOCKED（无条件拒绝，不看是否传 force）", () => {
    touch("main/run.gguf", 10);
    addModel({ name: "run-me", gguf_file: "main/run.gguf" });
    world.repo.createNamespace("dest");

    expectGuardCode(
      () => planFileMove(world.db, world.root, "run-me", { from: "main/run.gguf", toNamespace: "dest" }),
      "LOCKED",
    );
  });

  it("文件不存在 → NOT_FOUND", () => {
    world.repo.createNamespace("dest");
    expectGuardCode(
      () => planFileMove(world.db, world.root, null, { from: "main/nope.gguf", toNamespace: "dest" }),
      "NOT_FOUND",
    );
  });

  it("目标目录已存在同名文件 → CONFLICT", () => {
    touch("main/a.gguf", 10);
    touch("dest/a.gguf", 5);
    world.repo.createNamespace("dest");

    expectGuardCode(
      () => planFileMove(world.db, world.root, null, { from: "main/a.gguf", toNamespace: "dest" }),
      "CONFLICT",
    );
  });

  it("目标命名空间不存在 → INVALID_PATH", () => {
    touch("main/a.gguf", 10);
    expectGuardCode(
      () => planFileMove(world.db, world.root, null, { from: "main/a.gguf", toNamespace: "ghost" }),
      "INVALID_PATH",
    );
  });

  it("目标命名空间与当前相同 → INVALID_PATH", () => {
    touch("main/a.gguf", 10);
    expectGuardCode(
      () => planFileMove(world.db, world.root, null, { from: "main/a.gguf", toNamespace: "main" }),
      "INVALID_PATH",
    );
  });
});

describe("planFileRename：改名计划（单文件整名 vs 分片组前缀、glob 重写）", () => {
  it("单文件改名：整个文件名替换，精确引用同步重写", () => {
    touch("main/a.gguf", 10);
    addModel({ name: "m1", gguf_file: "main/a.gguf" });

    const plan = planFileRename(world.db, world.root, null, { from: "main/a.gguf", newName: "renamed.gguf" });

    expect(plan.fromRels).toEqual(["main/a.gguf"]);
    expect(plan.toRels).toEqual(["main/renamed.gguf"]);
    expect(plan.refChanges).toEqual([
      { modelName: "m1", field: "gguf_file", from: "main/a.gguf", to: "main/renamed.gguf" },
    ]);
  });

  it("单文件改名去掉 .gguf 后缀 → INVALID_PATH", () => {
    touch("main/a.gguf", 10);
    expectGuardCode(
      () => planFileRename(world.db, world.root, null, { from: "main/a.gguf", newName: "renamed" }),
      "INVALID_PATH",
    );
  });

  it("分片组改名：只改前缀，序号段保留，glob 引用同步重写为新前缀（改名后 glob 仍能匹配到全部分片）", () => {
    touch("main/qwen-00001-of-00002.gguf", 10);
    touch("main/qwen-00002-of-00002.gguf", 20);
    addModel({ name: "glob-model", gguf_file: "main/qwen-*.gguf" });

    const plan = planFileRename(world.db, world.root, null, {
      from: "main/qwen-00001-of-00002.gguf",
      newName: "qwen-v2",
    });

    expect([...plan.toRels].sort()).toEqual([
      "main/qwen-v2-00001-of-00002.gguf",
      "main/qwen-v2-00002-of-00002.gguf",
    ]);
    expect(plan.refChanges).toEqual([
      { modelName: "glob-model", field: "gguf_file", from: "main/qwen-*.gguf", to: "main/qwen-v2-*.gguf" },
    ]);
  });

  it("引用中含运行中模型 → LOCKED", () => {
    touch("main/run.gguf", 10);
    addModel({ name: "run-me", gguf_file: "main/run.gguf" });

    expectGuardCode(
      () => planFileRename(world.db, world.root, "run-me", { from: "main/run.gguf", newName: "renamed.gguf" }),
      "LOCKED",
    );
  });

  it("目标文件名已存在同目录 → CONFLICT", () => {
    touch("main/a.gguf", 10);
    touch("main/b.gguf", 5);

    expectGuardCode(
      () => planFileRename(world.db, world.root, null, { from: "main/a.gguf", newName: "b.gguf" }),
      "CONFLICT",
    );
  });

  it("文件不存在 → NOT_FOUND", () => {
    expectGuardCode(
      () => planFileRename(world.db, world.root, null, { from: "main/nope.gguf", newName: "x.gguf" }),
      "NOT_FOUND",
    );
  });
});

/**
 * 路径逃逸防护（主进程复核补充）：planFileMove / planFileRename 的 from 参数
 * 此前只经 splitNamespaceRel 校验段数，含 ../ 的路径要到 collectGroupRefs 内部
 * 的 getFileRefs 才被间接拦下——在那之前已经 readdir 过 models 根之外的目录，
 * 且防线依赖调用顺序不变。入口补了 assertInsideRoot 后由本组用例锁住。
 */
describe("planFileMove / planFileRename 的路径逃逸防护", () => {
  it("from 含 .. 时移动被拒，且不触碰 models 根之外", () => {
    // models 根的父目录放一个文件，逃逸成功的话它会被卷进移动计划
    writeFileSync(path.join(world.root, "..", "escape-probe.bin"), "x");
    try {
      expectCode(
        () => planFileMove(world.db, world.root, null, {
          from: "../escape-probe.bin",
          toNamespace: "shared",
        }),
        "INVALID_PATH",
      );
      // 探针仍在原处：拒绝发生在任何 rename 之前，根外文件未被卷走
      expect(existsSync(path.join(world.root, "..", "escape-probe.bin"))).toBe(true);
    } finally {
      rmSync(path.join(world.root, "..", "escape-probe.bin"), { force: true });
    }
  });

  it("from 含 .. 时改名被拒", () => {
    expectCode(
      () => planFileRename(world.db, world.root, null, {
        from: "../escape-probe.bin",
        newName: "pwned.gguf",
      }),
      "INVALID_PATH",
    );
  });

  it("from 为绝对路径时被拒", () => {
    expectCode(
      () => planFileMove(world.db, world.root, null, {
        from: "/etc/passwd",
        toNamespace: "shared",
      }),
      "INVALID_PATH",
    );
  });
});
