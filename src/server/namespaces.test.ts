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
  createNamespaceService,
  NamespaceError,
  type NamespaceService,
} from "./namespaces";

/**
 * 命名空间管理 + 模型移动空间服务层测试（M1 Task 12，TDD）
 *
 * 搭建与 modelsView.test.ts 同款：:memory: 库 + tmp models 根 + mock 适配器 +
 * createRuntimeService。host/panel 根合一（测试环境同一路径即可；生产中
 * 两根差异由 pathMaps 换算吸收，服务层按「扫描走 panel 根、mv 走 host 根」
 * 各取所需）。
 *
 * 语义（设计 §5.4）：
 * - 新建 = 仅 DB 行（唯一名 + `^[a-z0-9][a-z0-9-]*$`）
 * - 重命名 = host 侧 mv 目录（不存在跳过）+ 事务批量 UPDATE models.namespace
 *   + events；该空间有运行中模型 → 拒绝
 * - 删除 = 其下无模型配置才允许（只删 DB 行，磁盘留给文件页）
 * - moveModel：默认仅改 namespace 字段（跨空间引用成立）；可选 moveFiles
 *   把 glob 展开的 gguf 组 + mmproj 真移到目标空间目录并重写相对路径
 */

interface World {
  db: Database.Database;
  repo: ModelRepo;
  runtime: RuntimeService;
  service: NamespaceService;
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

/** 全部事件行（ts 升序即写入顺序） */
function events(): { ts: number; kind: string; message: string }[] {
  return world.db
    .prepare("SELECT ts, kind, message FROM events ORDER BY ts, id")
    .all() as { ts: number; kind: string; message: string }[];
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
  const runtime = createRuntimeService(db, createMockDockerAdapter(), root, root);
  world = {
    db,
    repo: createModelRepo(db),
    runtime,
    service: createNamespaceService(db, runtime, { panelRoot: root, hostRoot: root }),
    root,
  };
});

afterEach(() => {
  world.db.close();
  rmSync(world.root, { recursive: true, force: true });
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
});

describe("renameNamespace", () => {
  it("改 DB + 该空间所有模型 namespace 更新 + host 目录真 mv（旧目录消失、新目录带原文件）", async () => {
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
    expect(existsSync(path.join(world.root, "exp"))).toBe(false);
    expect(existsSync(path.join(world.root, "lab/a.gguf"))).toBe(true);
    expect(existsSync(path.join(world.root, "lab/b.gguf"))).toBe(true);
  });

  it("host 目录不存在时跳过 mv 不抛：DB 照常更新", async () => {
    world.service.createNamespace("exp");
    addModel({ name: "exp-a", namespace: "exp", gguf_file: "exp/a.gguf" });

    await world.service.renameNamespace("exp", "lab");

    expect(world.repo.getModel("exp-a")?.namespace).toBe("lab");
    expect(existsSync(path.join(world.root, "lab"))).toBe(false);
  });

  it("该空间有运行中模型 → 拒绝（错误含「运行中」，DB 与目录均不动）", async () => {
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

describe("moveModel", () => {
  it("默认 moveFiles=false：只 UPDATE namespace，gguf_file/mmproj_file 原样（跨空间引用成立）", async () => {
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

  it("moveFiles=true：glob 展开 gguf 组 + mmproj 全部 mv 到目标空间目录（惰性建目录）并重写相对路径", async () => {
    world.service.createNamespace("lab");
    addModel({
      name: "m1",
      namespace: "main",
      gguf_file: "main/m1-*.gguf",
      mmproj_file: "main/m1-mmproj.gguf",
    });
    touch("main/m1-00001-of-00002.gguf", 10);
    touch("main/m1-00002-of-00002.gguf", 20);
    touch("main/m1-mmproj.gguf", 5);

    const moved = await world.service.moveModel("m1", "lab", { moveFiles: true });

    // 目录惰性创建 + 三个文件都落位
    expect(existsSync(path.join(world.root, "lab/m1-00001-of-00002.gguf"))).toBe(true);
    expect(existsSync(path.join(world.root, "lab/m1-00002-of-00002.gguf"))).toBe(true);
    expect(existsSync(path.join(world.root, "lab/m1-mmproj.gguf"))).toBe(true);
    // 旧 rel 不再存在
    expect(existsSync(path.join(world.root, "main/m1-00001-of-00002.gguf"))).toBe(false);
    expect(existsSync(path.join(world.root, "main/m1-00002-of-00002.gguf"))).toBe(false);
    expect(existsSync(path.join(world.root, "main/m1-mmproj.gguf"))).toBe(false);
    // 配置重写为新 ns 段（glob 形态保留）
    expect(moved.namespace).toBe("lab");
    expect(moved.gguf_file).toBe("lab/m1-*.gguf");
    expect(moved.mmproj_file).toBe("lab/m1-mmproj.gguf");
    const got = world.repo.getModel("m1");
    expect(got?.namespace).toBe("lab");
    expect(got?.gguf_file).toBe("lab/m1-*.gguf");
    expect(got?.mmproj_file).toBe("lab/m1-mmproj.gguf");
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

describe("listOverview（GET /api/v1/namespaces 数据源）", () => {
  it("name/createdAt/modelCount/bytes 齐备：磁盘占用并入，未落盘的命名空间 bytes=0", async () => {
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
});
