import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, runMigrations } from "./db";
import { createModelRepo, type ModelRepo } from "./repo/models";
import type { ModelConfig } from "../core/schemas";
import { createFolder, FolderError, renameFolder, type RenameFolderDeps } from "./folders";
import { scanTree } from "./fsScanner";

/**
 * 文件夹管理服务层测试（阶段 1b B2/B4，TDD）
 *
 * renameFolder 不依赖 RuntimeService——LOCKED 判定只需要"当前运行模型名"
 * 这个字符串，测试直接把它塞进 deps，不必像 namespaces.test.ts 那样搭
 * mock docker 适配器 + 真的 startModel 一次，判定逻辑本身没有用到运行时。
 */

interface World {
  db: Database.Database;
  repo: ModelRepo;
  root: string;
  /** 宿主视角根：与 root 是两个不同的临时目录，全程必须保持空——folders.ts
   * 的写盘一律只准落在 root（面板视角），一旦有测试在这里写出文件就说明
   * 又把 hostRoot 拼回了本地文件系统路径（任务 H 修复的真机缺陷回归锁） */
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

function deps(runningModel: string | null = null): RenameFolderDeps {
  return { db: world.db, modelsRoot: world.root, runningModel };
}

/** 全程必须为空的宿主根断言：folders.ts 不该有任何写盘落在这里 */
function expectHostRootEmpty(): void {
  expect(readdirSync(world.hostRoot)).toEqual([]);
}

/** 断言抛 FolderError 且 code 匹配（返回 error 供进一步断言 message） */
function expectCode(fn: () => unknown, code: FolderError["code"]): FolderError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(FolderError);
  expect((caught as FolderError).code).toBe(code);
  return caught as FolderError;
}

beforeEach(() => {
  const db = openDb(":memory:");
  runMigrations(db);
  const root = mkdtempSync(path.join(tmpdir(), "llamapad-folders-"));
  const hostRoot = mkdtempSync(path.join(tmpdir(), "llamapad-folders-host-"));
  world = { db, repo: createModelRepo(db), root, hostRoot };
});

afterEach(() => {
  world.db.close();
  rmSync(world.root, { recursive: true, force: true });
  rmSync(world.hostRoot, { recursive: true, force: true });
});

describe("renameFolder", () => {
  it("整目录改名：一次 rename，旧目录消失、新目录带原文件，renamed 计其下文件数", () => {
    touch("exp/a.gguf", 10);
    touch("exp/b.gguf", 5);

    const result = renameFolder(deps(), { from: "exp", to: "lab" });

    expect(result.renamed).toBe(2);
    expect(result.refUpdates).toEqual([]);
    expect(existsSync(path.join(world.root, "exp"))).toBe(false);
    expect(existsSync(path.join(world.root, "lab/a.gguf"))).toBe(true);
    expect(existsSync(path.join(world.root, "lab/b.gguf"))).toBe(true);
    // 回归锁（任务 H）：物理落盘只准发生在面板视角根，宿主视角根全程为空
    expectHostRootEmpty();
  });

  it("重写精确引用：gguf_file 目录段换成新名字，namespace 绝不碰", () => {
    touch("exp/a.gguf", 10);
    addModel({ name: "m1", namespace: "main", gguf_file: "exp/a.gguf" });

    const result = renameFolder(deps(), { from: "exp", to: "lab" });

    expect(world.repo.getModel("m1")?.gguf_file).toBe("lab/a.gguf");
    expect(world.repo.getModel("m1")?.namespace).toBe("main");
    expect(result.refUpdates).toEqual([
      { modelName: "m1", field: "gguf_file", from: "exp/a.gguf", to: "lab/a.gguf" },
    ]);
  });

  it("glob 形态保留：exp/m-*.gguf 改名后仍是 lab/m-*.gguf", () => {
    touch("exp/m-00001-of-00002.gguf", 10);
    touch("exp/m-00002-of-00002.gguf", 20);
    addModel({ name: "m1", namespace: "main", gguf_file: "exp/m-*.gguf" });

    renameFolder(deps(), { from: "exp", to: "lab" });

    expect(world.repo.getModel("m1")?.gguf_file).toBe("lab/m-*.gguf");
  });

  it("共享引用方：一个物理文件被两个模型引用，改名后两边配置都更新（各自 namespace 不受影响）", () => {
    touch("exp/shared-mmproj.gguf", 5);
    touch("exp/m1.gguf", 10);
    touch("exp/m2.gguf", 10);
    addModel({
      name: "m1",
      namespace: "main",
      gguf_file: "exp/m1.gguf",
      mmproj_file: "exp/shared-mmproj.gguf",
    });
    world.repo.createNamespace("lab-ns");
    addModel({
      name: "m2",
      namespace: "lab-ns",
      gguf_file: "exp/m2.gguf",
      mmproj_file: "exp/shared-mmproj.gguf",
    });

    renameFolder(deps(), { from: "exp", to: "lab" });

    expect(world.repo.getModel("m1")?.gguf_file).toBe("lab/m1.gguf");
    expect(world.repo.getModel("m2")?.gguf_file).toBe("lab/m2.gguf");
    expect(world.repo.getModel("m1")?.mmproj_file).toBe("lab/shared-mmproj.gguf");
    expect(world.repo.getModel("m2")?.mmproj_file).toBe("lab/shared-mmproj.gguf");
    expect(world.repo.getModel("m1")?.namespace).toBe("main");
    expect(world.repo.getModel("m2")?.namespace).toBe("lab-ns");
  });

  it.each(["..", "", "  ", ".hidden", "main/.hidden"])(
    "目标名不安全 %j → 拒绝（INVALID_NAME），源目录不动",
    (bad) => {
      touch("exp/a.gguf", 10);
      expectCode(() => renameFolder(deps(), { from: "exp", to: bad }), "INVALID_NAME");
      expect(existsSync(path.join(world.root, "exp/a.gguf"))).toBe(true);
    },
  );

  it("目标可以是多级路径（阶段 3a），父目录不存在时自动建好", () => {
    touch("exp/a.gguf", 10);

    const result = renameFolder(deps(), { from: "exp", to: "lab/sub" });

    expect(result.renamed).toBe(1);
    expect(existsSync(path.join(world.root, "lab/sub/a.gguf"))).toBe(true);
    expect(existsSync(path.join(world.root, "exp"))).toBe(false);
  });

  it("renamed 计数递归展开嵌套子目录（阶段 3a：文件夹可以嵌套）", () => {
    touch("exp/a.gguf", 10);
    touch("exp/sub/b.gguf", 5);

    const result = renameFolder(deps(), { from: "exp", to: "lab" });

    expect(result.renamed).toBe(2);
    expect(existsSync(path.join(world.root, "lab/sub/b.gguf"))).toBe(true);
  });

  // 缺陷 2 回归锁（批 1）：整目录 renameSync 会完整保留子目录结构，但曾经的
  // 引用重写复用的是 rewriteRefFolder（只保留 basename），子目录段被压平——
  // gguf_file 指向的路径与 renameSync 之后文件的真实磁盘位置对不上。HF 仓库
  // 按 f.path 下载天然产生子目录（如 UD-Q4_K_XL/model.gguf），是高频路径。
  it("引用带子目录的 gguf_file 改名后，配置路径与 renameSync 之后的真实磁盘位置一致（缺陷 2 回归锁）", () => {
    touch("exp/sub/b.gguf", 5);
    addModel({ name: "m1", namespace: "main", gguf_file: "exp/sub/b.gguf" });

    const result = renameFolder(deps(), { from: "exp", to: "lab" });

    // 引用值：子目录段必须原样保留，不能被压成 lab/b.gguf
    expect(world.repo.getModel("m1")?.gguf_file).toBe("lab/sub/b.gguf");
    expect(result.refUpdates).toEqual([
      { modelName: "m1", field: "gguf_file", from: "exp/sub/b.gguf", to: "lab/sub/b.gguf" },
    ]);
    // 真实磁盘位置：renameSync 是整目录搬迁，物理文件确实落在这个路径
    expect(existsSync(path.join(world.root, "lab/sub/b.gguf"))).toBe(true);
    expect(existsSync(path.join(world.root, "exp"))).toBe(false);
  });

  // 缺陷 2 边界回归锁（批 1，简报裁定）：配置值的目录段本身带通配符时
  // （fsScanner 的多级目录 glob 支持目录段通配），renameFolder 遍历到的物理
  // rel 以真实目录名开头，但配置值本身不以 `${from}/` 开头，无法可靠做前缀
  // 替换——退回 rewriteRefFolder 既有行为（只保留 basename，允许丢中间层级），
  // 不比改造前更差，但也不是正确结果，专门锁定这条已知边界不再变化。
  it("配置目录段本身带通配符时无法可靠前缀替换，退回既有行为（已知边界，非本批修复范围）", () => {
    touch("exp/sub/x.gguf", 5);
    // 目录段用通配符写成 "e*"，展开后仍命中磁盘上的 exp/sub/x.gguf
    addModel({ name: "m1", namespace: "main", gguf_file: "e*/sub/x.gguf" });

    renameFolder(deps(), { from: "exp", to: "lab" });

    // 已知限制：中间的 sub/ 段丢失，与 rewriteRefFolder(value, "lab") 的结果
    // 一致——这不是「改名后的正确路径」，是明确写进简报的既有行为兜底
    expect(world.repo.getModel("m1")?.gguf_file).toBe("lab/x.gguf");
  });

  it("不允许把目录改名到自身或自己的子目录里（INVALID_NAME，renameSync 对此行为未定义）", () => {
    touch("exp/a.gguf", 10);

    expectCode(() => renameFolder(deps(), { from: "exp", to: "exp" }), "INVALID_NAME");
    expectCode(() => renameFolder(deps(), { from: "exp", to: "exp/sub" }), "INVALID_NAME");
    expect(existsSync(path.join(world.root, "exp/a.gguf"))).toBe(true);
  });

  it("目标名前缀相同但不是真子目录（exp vs exp2）不会被误判为子目录改名", () => {
    touch("exp/a.gguf", 10);

    const result = renameFolder(deps(), { from: "exp", to: "exp2" });

    expect(result.renamed).toBe(1);
    expect(existsSync(path.join(world.root, "exp2/a.gguf"))).toBe(true);
  });

  it("from 不安全同样拒绝（INVALID_NAME）", () => {
    expectCode(() => renameFolder(deps(), { from: "../etc", to: "lab" }), "INVALID_NAME");
  });

  it("from 目录不存在 → 拒绝（NOT_FOUND）", () => {
    expectCode(() => renameFolder(deps(), { from: "ghost", to: "lab" }), "NOT_FOUND");
  });

  it("to 已存在（目录）→ 拒绝（CONFLICT），源目录不动", () => {
    touch("exp/a.gguf", 10);
    touch("lab/b.gguf", 5);

    expectCode(() => renameFolder(deps(), { from: "exp", to: "lab" }), "CONFLICT");
    expect(existsSync(path.join(world.root, "exp/a.gguf"))).toBe(true);
  });

  it("to 已存在（普通文件而非目录）→ 同样拒绝（CONFLICT）", () => {
    touch("exp/a.gguf", 10);
    touch("lab", 1); // "lab" 是一个文件，不是目录

    expectCode(() => renameFolder(deps(), { from: "exp", to: "lab" }), "CONFLICT");
  });

  it("目录下有文件被运行中模型引用 → 拒绝（LOCKED），配置与目录均不动", () => {
    touch("exp/a.gguf", 10);
    addModel({ name: "m1", namespace: "main", gguf_file: "exp/a.gguf" });

    const error = expectCode(
      () => renameFolder(deps("m1"), { from: "exp", to: "lab" }),
      "LOCKED",
    );
    expect(error.message).toContain("运行中");
    expect(existsSync(path.join(world.root, "exp/a.gguf"))).toBe(true);
    expect(world.repo.getModel("m1")?.gguf_file).toBe("exp/a.gguf");
  });

  it("运行中模型引用的是别的目录 → 不受影响，正常改名", () => {
    touch("exp/a.gguf", 10);
    touch("keep/b.gguf", 5);
    addModel({ name: "m1", namespace: "main", gguf_file: "exp/a.gguf" });
    addModel({ name: "m2", namespace: "main", gguf_file: "keep/b.gguf" });

    renameFolder(deps("m2"), { from: "exp", to: "lab" });

    expect(world.repo.getModel("m1")?.gguf_file).toBe("lab/a.gguf");
  });
});

describe("createFolder（C5 服务层部分）", () => {
  it("单级目录：mkdirSync 建好，返回原样 path", () => {
    const result = createFolder(deps(), { path: "main" });

    expect(result).toEqual({ path: "main" });
    expect(existsSync(path.join(world.root, "main"))).toBe(true);
    // 回归锁（任务 H）：物理落盘只准发生在面板视角根，宿主视角根全程为空
    expectHostRootEmpty();
  });

  it("多级目录一次建好（recursive），父目录不必预先存在", () => {
    createFolder(deps(), { path: "main/70b/awq" });

    expect(existsSync(path.join(world.root, "main/70b/awq"))).toBe(true);
  });

  it("已存在（目录）→ 拒绝（CONFLICT）", () => {
    touch("main/a.gguf", 1);
    expectCode(() => createFolder(deps(), { path: "main" }), "CONFLICT");
  });

  it("已存在（同名文件而非目录）→ 同样拒绝（CONFLICT）", () => {
    touch("main", 1); // "main" 是文件
    expectCode(() => createFolder(deps(), { path: "main" }), "CONFLICT");
  });

  it.each(["..", "", "  ", ".hidden", "main/.hidden", "../escape"])(
    "路径不安全 %j → 拒绝（INVALID_NAME），不建任何目录",
    (bad) => {
      expectCode(() => createFolder(deps(), { path: bad }), "INVALID_NAME");
    },
  );

  it("绝对路径 → 拒绝（INVALID_NAME）", () => {
    expectCode(() => createFolder(deps(), { path: "/etc/evil" }), "INVALID_NAME");
  });

  // 目录段数上限比 walkTree 的 MAX_PATH_DEPTH（路径总段数，含文件名段）少 1：
  // 目录里的文件至少还要占一段，8 段目录建出来后其内文件必为 9 段，
  // 会被 walkTree 整个跳过（建得出来但全站看不见），见 fsScanner.ts 顶部注释。
  it("层级超过目录段数上限（7 层）→ 拒绝（INVALID_NAME），不静默截断新建", () => {
    expectCode(
      () => createFolder(deps(), { path: "a/b/c/d/e/f/g/h" }), // 8 段
      "INVALID_NAME",
    );
    expect(existsSync(path.join(world.root, "a"))).toBe(false);
  });

  it("层级恰为目录段数上限（7 层）仍可建，且建出的目录在 scanTree 里一定看得见", () => {
    createFolder(deps(), { path: "a/b/c/d/e/f/g" }); // 7 段，恰为上限
    expect(existsSync(path.join(world.root, "a/b/c/d/e/f/g"))).toBe(true);

    touch("a/b/c/d/e/f/g/model.gguf", 1);
    const tree = scanTree(world.root);
    expect(tree.map((n) => n.folder)).toContain("a/b/c/d/e/f/g");
    expect(tree.find((n) => n.folder === "a/b/c/d/e/f/g")!.files.map((f) => f.rel)).toEqual([
      "a/b/c/d/e/f/g/model.gguf",
    ]);
  });
});
