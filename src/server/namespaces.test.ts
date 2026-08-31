import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, runMigrations } from "./db";
import { createMockDockerAdapter } from "./adapters/mock";
import { createModelRepo, type ModelRepo } from "./repo/models";
import type { ModelConfig } from "../core/schemas";
import { createRuntimeService, type RuntimeService } from "./runtime";
import {
  createNamespaceService,
  NamespaceError,
  type NamespaceService,
} from "./namespaces";

/**
 * 命名空间管理 + 模型移动服务层测试（M1 Task 12；阶段 1b 改按 B1/B5/B6 的
 * 拆分语义重写，TDD）
 *
 * 搭建与 modelsView.test.ts 同款：:memory: 库 + tmp models 根 + mock 适配器 +
 * createRuntimeService。host/panel 根故意用两个不同的临时目录（而不是合
 * 一）：namespaces.ts 的 moveModelFiles 曾经错拿宿主视角根落盘，两根合一
 * 会让这个 bug 永远测不出来（任务 H 回归锁）——host 根只喂给
 * createRuntimeService 组装 Docker bind 挂载字符串，全程不应有任何文件
 * 落在里面，见 expectHostRootEmpty。
 *
 * 语义（阶段 1b 起：命名空间与文件夹彻底解耦，详见 namespaces.ts 顶部注释）：
 * - 新建 = 仅 DB 行（唯一名 + `^[a-z0-9][a-z0-9._-]*$`，阶段 2 B7 放开点号与下划线）
 * - 重命名 = 纯 DB 操作：事务批量 UPDATE models.namespace + events；不再碰
 *   磁盘目录、也不改 gguf_file/mmproj_file（B1 修复的数据损坏缺陷回归锁）；
 *   该空间有运行中模型 → 拒绝
 * - 删除 = 其下无模型配置才允许（只删 DB 行，磁盘留给文件页）
 * - moveModel(name, to)：纯改 namespace 字段，绝不动物理文件
 * - moveModelFiles(name, toFolder)：只挪物理文件 + 重写路径字段（glob 形态
 *   保留），绝不改 namespace；目标校验磁盘既有目录，不再查 namespaces 表
 * - listOverview 的 bytes：按该空间下模型引用文件（gguf_file/mmproj_file，
 *   含 glob 展开）大小之和计算，按物理文件 rel 去重，不再是"同名目录大小"
 */

interface World {
  db: Database.Database;
  repo: ModelRepo;
  runtime: RuntimeService;
  service: NamespaceService;
  root: string;
  /** 宿主视角根：只喂给 createRuntimeService，全程必须保持空——见
   * expectHostRootEmpty（任务 H 回归锁） */
  hostRoot: string;
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

/** 全部事件行（ts 升序即写入顺序） */
function events(): { ts: number; kind: string; message: string }[] {
  return world.db
    .prepare("SELECT ts, kind, message FROM events ORDER BY ts, id")
    .all() as { ts: number; kind: string; message: string }[];
}

/** 全程必须为空的宿主根断言：namespaces.ts 不该有任何写盘落在这里 */
function expectHostRootEmpty(): void {
  expect(readdirSync(world.hostRoot)).toEqual([]);
}

/** 断言抛 NamespaceError 且 code 匹配（返回 error 供进一步断言 message） */
async function expectCode(
  fn: () => unknown,
  code: NamespaceError["code"],
): Promise<NamespaceError> {
  let caught: unknown;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(NamespaceError);
  expect((caught as NamespaceError).code).toBe(code);
  return caught as NamespaceError;
}

beforeEach(() => {
  const db = openDb(":memory:");
  runMigrations(db);
  const root = mkdtempSync(path.join(tmpdir(), "llamapad-namespaces-"));
  const hostRoot = mkdtempSync(path.join(tmpdir(), "llamapad-namespaces-host-"));
  const runtime = createRuntimeService(db, createMockDockerAdapter(), hostRoot, root);
  world = {
    db,
    repo: createModelRepo(db),
    runtime,
    service: createNamespaceService(db, runtime, { panelRoot: root }),
    root,
    hostRoot,
  };
});

afterEach(() => {
  world.db.close();
  rmSync(world.root, { recursive: true, force: true });
  rmSync(world.hostRoot, { recursive: true, force: true });
});

describe("createNamespace", () => {
  it("合法名成功：DB 出现该行 + events 记 namespace.create", async () => {
    world.service.createNamespace("exp");
    expect(world.repo.listNamespaces()).toContain("exp");
    expect(events().map((e) => e.kind)).toContain("namespace.create");
  });

  it("重复名抛错（DUPLICATE）", async () => {
    world.service.createNamespace("exp");
    await expectCode(() => world.service.createNamespace("exp"), "DUPLICATE");
  });

  it.each(["Abc", "a b", "", "-x", "素材"])("非法名 %j 抛错（INVALID_NAME）", async (name) => {
    await expectCode(() => world.service.createNamespace(name), "INVALID_NAME");
    expect(world.repo.listNamespaces()).toEqual(["main"]);
  });

  it.each(["qwen3.6", "a_b", "v1.0.0"])("B7 放开字符集后 %j 合法", async (name) => {
    world.service.createNamespace(name);
    expect(world.repo.listNamespaces()).toContain(name);
  });

  it.each(["..", ".hidden", "Main", "a/b"])(
    "B7 放开字符集后 %j 仍抛错（首字符限定 + 不放开大写守住的危险形态）",
    async (name) => {
      await expectCode(() => world.service.createNamespace(name), "INVALID_NAME");
      expect(world.repo.listNamespaces()).toEqual(["main"]);
    },
  );
});

describe("renameNamespace", () => {
  it("纯 DB 操作：改命名空间行 + 该空间所有模型 namespace 更新，gguf_file 保持原值不变（B1 缺陷回归锁）", async () => {
    world.service.createNamespace("exp");
    addModel({ name: "exp-a", namespace: "exp", gguf_file: "exp/a.gguf" });
    addModel({ name: "exp-b", namespace: "exp", gguf_file: "exp/b.gguf" });
    addModel({ name: "keep", namespace: "main", gguf_file: "main/a.gguf" });
    touch("exp/a.gguf", 10);
    touch("exp/b.gguf", 20);

    await world.service.renameNamespace("exp", "lab");

    expect(world.repo.listNamespaces()).toEqual(["lab", "main"]);
    expect(world.repo.getModel("exp-a")?.namespace).toBe("lab");
    expect(world.repo.getModel("exp-b")?.namespace).toBe("lab");
    expect(world.repo.getModel("keep")?.namespace).toBe("main");
    // 回归锁核心：gguf_file 的目录段不随命名空间改名而改写——命名空间是纯
    // 标签，磁盘目录与它无关。缺陷修复前这里会残留旧目录段（exp/...），
    // 导致 resolveModelFiles 判定文件缺失，模型启动必失败
    expect(world.repo.getModel("exp-a")?.gguf_file).toBe("exp/a.gguf");
    expect(world.repo.getModel("exp-b")?.gguf_file).toBe("exp/b.gguf");
  });

  it("磁盘目录不受影响：改名后 exp/ 原地保留、lab/ 不会凭空出现（回归锁——修复前这里会真 mv 目录）", async () => {
    world.service.createNamespace("exp");
    addModel({ name: "exp-a", namespace: "exp", gguf_file: "exp/a.gguf" });
    touch("exp/a.gguf", 10);

    await world.service.renameNamespace("exp", "lab");

    expect(existsSync(path.join(world.root, "exp/a.gguf"))).toBe(true);
    expect(existsSync(path.join(world.root, "lab"))).toBe(false);
  });

  it("该空间有运行中模型 → 拒绝（错误含「运行中」，DB 不动）", async () => {
    world.service.createNamespace("exp");
    addModel({ name: "exp-a", namespace: "exp", gguf_file: "exp/a.gguf" });
    touch("exp/a.gguf", 10);
    await world.runtime.startModel("exp-a");

    const error = await expectCode(async () => world.service.renameNamespace("exp", "lab"), "RUNNING");
    expect(error.message).toContain("运行中");
    expect(world.repo.listNamespaces()).toContain("exp");
    expect(world.repo.getModel("exp-a")?.namespace).toBe("exp");
    expect(existsSync(path.join(world.root, "exp/a.gguf"))).toBe(true);
  });

  it("目标名已存在 → 拒绝（DUPLICATE）", async () => {
    world.service.createNamespace("exp");
    world.service.createNamespace("lab");
    await expectCode(async () => world.service.renameNamespace("exp", "lab"), "DUPLICATE");
  });

  it("源不存在 → 拒绝（NOT_FOUND）；目标名非法 → 拒绝（INVALID_NAME）", async () => {
    await expectCode(async () => world.service.renameNamespace("ghost", "lab"), "NOT_FOUND");
    world.service.createNamespace("exp");
    await expectCode(async () => world.service.renameNamespace("exp", "Bad Name"), "INVALID_NAME");
  });

  it("events 记 kind=namespace.rename（message 含 from → to）", async () => {
    world.service.createNamespace("exp");
    await world.service.renameNamespace("exp", "lab");
    const hit = events().find((e) => e.kind === "namespace.rename");
    expect(hit).toBeDefined();
    expect(hit?.message).toContain("exp");
    expect(hit?.message).toContain("lab");
  });
});

describe("deleteNamespace", () => {
  it("其下无配置 → 成功删行 + events 记 namespace.delete（磁盘目录不动）", async () => {
    world.service.createNamespace("exp");
    touch("exp/a.gguf", 10);

    world.service.deleteNamespace("exp");

    expect(world.repo.listNamespaces()).toEqual(["main"]);
    expect(existsSync(path.join(world.root, "exp/a.gguf"))).toBe(true);
    expect(events().map((e) => e.kind)).toContain("namespace.delete");
  });

  it("有配置 → 拒绝（NOT_EMPTY，错误列出模型数）", async () => {
    world.service.createNamespace("exp");
    addModel({ name: "exp-a", namespace: "exp", gguf_file: "exp/a.gguf" });
    addModel({ name: "exp-b", namespace: "exp", gguf_file: "exp/b.gguf" });

    const error = await expectCode(() => world.service.deleteNamespace("exp"), "NOT_EMPTY");
    expect(error.message).toContain("2");
    expect(world.repo.listNamespaces()).toContain("exp");
  });

  it("main 空间也允许删除（用户自由管理；导入默认落点，删除后导入会重建）", async () => {
    world.service.deleteNamespace("main");
    expect(world.repo.listNamespaces()).toEqual([]);
  });

  it("不存在 → 拒绝（NOT_FOUND）", async () => {
    await expectCode(() => world.service.deleteNamespace("ghost"), "NOT_FOUND");
  });
});

describe("moveModel（纯改分组，绝不动文件——阶段 1b B6 拆分）", () => {
  it("成功：只 UPDATE namespace，gguf_file/mmproj_file 原样（跨空间引用成立）", async () => {
    world.service.createNamespace("lab");
    addModel({
      name: "m1",
      namespace: "main",
      gguf_file: "main/m1.gguf",
      mmproj_file: "main/m1-mmproj.gguf",
    });
    touch("main/m1.gguf", 10);

    const moved = await world.service.moveModel("m1", "lab");

    expect(moved.namespace).toBe("lab");
    expect(moved.gguf_file).toBe("main/m1.gguf");
    expect(moved.mmproj_file).toBe("main/m1-mmproj.gguf");
    expect(existsSync(path.join(world.root, "main/m1.gguf"))).toBe(true);
    expect(events().some((e) => e.kind === "model.move")).toBe(true);
  });

  it("运行中 → 拒绝（RUNNING，错误含「运行中」）", async () => {
    world.service.createNamespace("lab");
    addModel({ name: "m1", namespace: "main", gguf_file: "main/m1.gguf" });
    touch("main/m1.gguf", 10);
    await world.runtime.startModel("m1");

    const error = await expectCode(async () => world.service.moveModel("m1", "lab"), "RUNNING");
    expect(error.message).toContain("运行中");
    expect(world.repo.getModel("m1")?.namespace).toBe("main");
  });

  it("目标 ns 不存在 → 拒绝（BAD_TARGET，提示先建）", async () => {
    addModel({ name: "m1", namespace: "main", gguf_file: "main/m1.gguf" });
    const error = await expectCode(async () => world.service.moveModel("m1", "ghost"), "BAD_TARGET");
    expect(error.message).toContain("先创建");
  });

  it("同名空间移动（from === to）→ 拒绝（SAME_NAMESPACE，清晰错误）", async () => {
    addModel({ name: "m1", namespace: "main", gguf_file: "main/m1.gguf" });
    const error = await expectCode(async () => world.service.moveModel("m1", "main"), "SAME_NAMESPACE");
    expect(error.message).toContain("相同");
  });

  it("模型不存在 → 拒绝（NOT_FOUND）", async () => {
    world.service.createNamespace("lab");
    await expectCode(async () => world.service.moveModel("ghost", "lab"), "NOT_FOUND");
  });
});

describe("moveModelFiles（只挪物理文件，绝不改 namespace——阶段 1b B6 拆分）", () => {
  it("glob 展开 gguf 组 + mmproj 全部 mv 到目标目录并重写相对路径，namespace 不变", async () => {
    mkdirSync(path.join(world.root, "lab"), { recursive: true });
    addModel({
      name: "m1",
      namespace: "main",
      gguf_file: "main/m1-*.gguf",
      mmproj_file: "main/m1-mmproj.gguf",
    });
    touch("main/m1-00001-of-00002.gguf", 10);
    touch("main/m1-00002-of-00002.gguf", 20);
    touch("main/m1-mmproj.gguf", 5);

    const moved = await world.service.moveModelFiles("m1", "lab");

    expect(existsSync(path.join(world.root, "lab/m1-00001-of-00002.gguf"))).toBe(true);
    expect(existsSync(path.join(world.root, "lab/m1-00002-of-00002.gguf"))).toBe(true);
    expect(existsSync(path.join(world.root, "lab/m1-mmproj.gguf"))).toBe(true);
    expect(existsSync(path.join(world.root, "main/m1-00001-of-00002.gguf"))).toBe(false);
    expect(existsSync(path.join(world.root, "main/m1-00002-of-00002.gguf"))).toBe(false);
    expect(existsSync(path.join(world.root, "main/m1-mmproj.gguf"))).toBe(false);
    // 回归锁（任务 H）：moveModelFiles 只准落在面板视角根，宿主视角根全程为空
    expectHostRootEmpty();
    // 核心：namespace 绝不碰（B1/B6 拆分后的立场——文件夹与命名空间无关）
    expect(moved.namespace).toBe("main");
    expect(moved.gguf_file).toBe("lab/m1-*.gguf");
    expect(moved.mmproj_file).toBe("lab/m1-mmproj.gguf");
    const got = world.repo.getModel("m1");
    expect(got?.namespace).toBe("main");
    expect(got?.gguf_file).toBe("lab/m1-*.gguf");
    expect(got?.mmproj_file).toBe("lab/m1-mmproj.gguf");
  });

  it("gguf glob 与 mmproj 命中同一物理文件时只移动一次（不因重复 rename 报错，现有行为）", async () => {
    mkdirSync(path.join(world.root, "lab"), { recursive: true });
    addModel({
      name: "m1",
      namespace: "main",
      gguf_file: "main/dup-*.gguf",
      mmproj_file: "main/dup-mmproj.gguf", // 同时被 gguf 的 glob 命中
    });
    touch("main/dup-00001-of-00001.gguf", 10);
    touch("main/dup-mmproj.gguf", 5);

    const moved = await world.service.moveModelFiles("m1", "lab");

    expect(existsSync(path.join(world.root, "lab/dup-00001-of-00001.gguf"))).toBe(true);
    expect(existsSync(path.join(world.root, "lab/dup-mmproj.gguf"))).toBe(true);
    expect(moved.gguf_file).toBe("lab/dup-*.gguf");
    expect(moved.mmproj_file).toBe("lab/dup-mmproj.gguf");
  });

  it("共享文件被 2 个模型引用：移动后两个模型的配置都更新，namespace 均不变（设计 §1.1 缺陷回归锁）", async () => {
    mkdirSync(path.join(world.root, "lab"), { recursive: true });
    addModel({
      name: "m1",
      namespace: "main",
      gguf_file: "main/m1.gguf",
      mmproj_file: "main/shared-mmproj.gguf",
    });
    addModel({
      name: "m2",
      namespace: "main",
      gguf_file: "main/m2.gguf",
      mmproj_file: "main/shared-mmproj.gguf", // 与 m1 共享同一 mmproj 物理文件
    });
    touch("main/m1.gguf", 10);
    touch("main/m2.gguf", 10);
    touch("main/shared-mmproj.gguf", 5);

    const moved = await world.service.moveModelFiles("m1", "lab");

    // 发起移动的 m1：路径字段重写，namespace 不动
    expect(moved.namespace).toBe("main");
    expect(moved.mmproj_file).toBe("lab/shared-mmproj.gguf");
    // 共享方 m2：namespace 不变，被引用的 mmproj_file 同步重写——这正是缺陷
    // 修复点：现状下 m2 会被静默留在旧路径，下次启动报"模型文件缺失"
    const m2 = world.repo.getModel("m2");
    expect(m2?.namespace).toBe("main");
    expect(m2?.mmproj_file).toBe("lab/shared-mmproj.gguf");
    // 物理文件只有一份，且已落到新位置
    expect(existsSync(path.join(world.root, "lab/shared-mmproj.gguf"))).toBe(true);
    expect(existsSync(path.join(world.root, "main/shared-mmproj.gguf"))).toBe(false);
  });

  it("共享方中有运行中模型 → 拒绝（LOCKED），文件与两侧配置均不改动", async () => {
    mkdirSync(path.join(world.root, "lab"), { recursive: true });
    addModel({
      name: "m1",
      namespace: "main",
      gguf_file: "main/m1.gguf",
      mmproj_file: "main/shared-mmproj.gguf",
    });
    addModel({
      name: "m2",
      namespace: "main",
      gguf_file: "main/m2.gguf",
      mmproj_file: "main/shared-mmproj.gguf",
    });
    touch("main/m1.gguf", 10);
    touch("main/m2.gguf", 10);
    touch("main/shared-mmproj.gguf", 5);
    await world.runtime.startModel("m2"); // 共享方 m2 运行中，m1 自身并未运行

    const error = await expectCode(
      async () => world.service.moveModelFiles("m1", "lab"),
      "LOCKED",
    );
    expect(error.message).toContain("运行中");

    // 文件未被移动，两个模型的配置均保持原样
    expect(existsSync(path.join(world.root, "main/shared-mmproj.gguf"))).toBe(true);
    expect(existsSync(path.join(world.root, "lab/shared-mmproj.gguf"))).toBe(false);
    expect(world.repo.getModel("m1")?.mmproj_file).toBe("main/shared-mmproj.gguf");
    expect(world.repo.getModel("m2")?.mmproj_file).toBe("main/shared-mmproj.gguf");
  });

  it("模型自身运行中 → 拒绝（RUNNING，错误含「运行中」）", async () => {
    mkdirSync(path.join(world.root, "lab"), { recursive: true });
    addModel({ name: "m1", namespace: "main", gguf_file: "main/m1.gguf" });
    touch("main/m1.gguf", 10);
    await world.runtime.startModel("m1");

    const error = await expectCode(async () => world.service.moveModelFiles("m1", "lab"), "RUNNING");
    expect(error.message).toContain("运行中");
    expect(world.repo.getModel("m1")?.gguf_file).toBe("main/m1.gguf");
  });

  it("目标目录不存在于磁盘 → 拒绝（BAD_TARGET，不再校验 namespaces 表）", async () => {
    addModel({ name: "m1", namespace: "main", gguf_file: "main/m1.gguf" });
    touch("main/m1.gguf", 10);

    const error = await expectCode(
      async () => world.service.moveModelFiles("m1", "ghost-dir"),
      "BAD_TARGET",
    );
    expect(error.message).toContain("ghost-dir");
  });

  it("模型不存在 → 拒绝（NOT_FOUND）", async () => {
    mkdirSync(path.join(world.root, "lab"), { recursive: true });
    await expectCode(async () => world.service.moveModelFiles("ghost", "lab"), "NOT_FOUND");
  });
});

describe("listOverview（GET /api/v1/namespaces 数据源，阶段 1b B5 改按模型引用文件计算）", () => {
  it("name/createdAt/modelCount/bytes 齐备：bytes 按模型引用文件求和，无模型引用的空间 bytes=0", async () => {
    world.service.createNamespace("lab");
    addModel({ name: "m1", namespace: "main", gguf_file: "main/m1.gguf" });
    addModel({ name: "m2", namespace: "lab", gguf_file: "lab/m2.gguf" });
    touch("main/m1.gguf", 100);
    touch("lab/m2.gguf", 50);

    const overview = await world.service.listOverview();

    expect(overview.map((n) => n.name)).toEqual(["lab", "main"]);
    const main = overview.find((n) => n.name === "main");
    const lab = overview.find((n) => n.name === "lab");
    expect(main?.modelCount).toBe(1);
    expect(main?.bytes).toBe(100);
    expect(lab?.modelCount).toBe(1);
    expect(lab?.bytes).toBe(50);
    expect(main?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("回归锁核心：模型 gguf_file 指向别的目录时，该空间的 bytes 把那个文件算进来（B5 修复真机 71 倍失真）", async () => {
    // main 空间的模型文件散在 gemma4/，main/ 目录本身没有任何文件——旧口径
    // （同名目录大小）会给出 bytes=0，与真实占用（gemma4/ 里那份文件）差全部
    addModel({ name: "m1", namespace: "main", gguf_file: "gemma4/m1.gguf" });
    touch("gemma4/m1.gguf", 200);

    const overview = await world.service.listOverview();

    expect(overview.find((n) => n.name === "main")?.bytes).toBe(200);
  });

  it("同一物理文件被两个模型共享时只算一次（按 rel 去重，不虚高）", async () => {
    addModel({
      name: "m1",
      namespace: "main",
      gguf_file: "main/m1.gguf",
      mmproj_file: "main/shared-mmproj.gguf",
    });
    addModel({
      name: "m2",
      namespace: "main",
      gguf_file: "main/m2.gguf",
      mmproj_file: "main/shared-mmproj.gguf",
    });
    touch("main/m1.gguf", 10);
    touch("main/m2.gguf", 20);
    touch("main/shared-mmproj.gguf", 5);

    const overview = await world.service.listOverview();

    // 10 + 20 + 5，共享的 mmproj 只计一次（若未去重会变成 40）
    expect(overview.find((n) => n.name === "main")?.bytes).toBe(35);
  });

  it("gguf glob 与 mmproj 命中同一物理文件时同样只算一次", async () => {
    addModel({
      name: "m1",
      namespace: "main",
      gguf_file: "main/dup-*.gguf",
      mmproj_file: "main/dup-mmproj.gguf",
    });
    touch("main/dup-00001-of-00001.gguf", 10);
    touch("main/dup-mmproj.gguf", 5);

    const overview = await world.service.listOverview();

    expect(overview.find((n) => n.name === "main")?.bytes).toBe(15);
  });

  it("文件缺失不算错误，计 0", async () => {
    addModel({ name: "m1", namespace: "main", gguf_file: "main/missing.gguf" });

    const overview = await world.service.listOverview();

    expect(overview.find((n) => n.name === "main")?.bytes).toBe(0);
  });
});
