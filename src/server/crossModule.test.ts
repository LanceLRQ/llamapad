import { beforeEach, afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, runMigrations } from "./db";
import { createMockDockerAdapter } from "./adapters/mock";
import { createModelRepo, type ModelRepo } from "./repo/models";
import { createNamespaceService, type NamespaceService } from "./namespaces";
import { createRuntimeService } from "./runtime";
import { planFileMove, planFileRename } from "./filesApi";
import { moveFiles } from "./fileMove";
import { listFileMeta, relinkFile, setFileMetaFields } from "./fileMeta";
import { defaultConfigSchema, type ModelConfig } from "../core/schemas";
import { buildContainerSpec } from "./runtime";
import { draftToPatch } from "../lib/image-card-form";

/**
 * 跨模块联调：文件移动/改名（模块一）与文件元信息（模块二）本是并发落地的
 * 两块，各自的单测都绿，但两者之间的联动没有任何测试守着——元信息的立身之本
 * 正是「防止移动导致信息丢失」，这条链断了整个模块二就名存实亡。
 */

interface World {
  db: Database.Database;
  repo: ModelRepo;
  ns: NamespaceService;
  root: string;
}

let world: World;

function touch(rel: string, bytes = 16): void {
  const abs = path.join(world.root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, Buffer.alloc(bytes, "x"));
}

function addModel(partial: Partial<ModelConfig> & { name: string }): void {
  world.repo.createModel({
    display_name: partial.name,
    namespace: "main",
    gguf_file: "main/a.gguf",
    overrides: {},
    ...partial,
  });
}

/** 复现 POST /api/v1/files/move 的服务端调用链（route 只多做 zod 校验与快照）。
 * mkdir 挪到 planFileMove 之前：A6 把目标目录校验从"命名空间表已登记"改成
 * "磁盘上已存在"后，route 不再惰性建目录，这里的预建目录就不只是给
 * moveFiles 的物理 rename 铺路，也是让 planFileMove 本身的存在性校验通过。 */
function doMove(from: string, toFolder: string): void {
  mkdirSync(path.join(world.root, toFolder), { recursive: true });
  const plan = planFileMove(world.db, world.root, null, { from, toFolder });
  moveFiles(
    { db: world.db },
    {
      from: plan.fromRels.map((rel) => path.join(world.root, rel)),
      to: plan.toRels.map((rel) => path.join(world.root, rel)),
      refUpdates: plan.refUpdates,
    },
  );
}

/** 复现 POST /api/v1/files/rename 的服务端调用链 */
function doRename(from: string, newName: string): void {
  const plan = planFileRename(world.db, world.root, null, { from, newName });
  moveFiles(
    { db: world.db },
    {
      from: plan.fromRels.map((rel) => path.join(world.root, rel)),
      to: plan.toRels.map((rel) => path.join(world.root, rel)),
      refUpdates: plan.refUpdates,
    },
  );
}

beforeEach(() => {
  const db = openDb(":memory:");
  runMigrations(db);
  const root = mkdtempSync(path.join(tmpdir(), "llamapad-cross-"));
  const runtime = createRuntimeService(db, createMockDockerAdapter(), root, root);
  world = {
    db,
    repo: createModelRepo(db),
    ns: createNamespaceService(db, runtime, { panelRoot: root, hostRoot: root }),
    root,
  };
  world.repo.createNamespace("main");
});

afterEach(() => {
  world.db.close();
  rmSync(world.root, { recursive: true, force: true });
});

describe("文件移动/改名 与 file_meta 的联动", () => {
  it("移动文件后，用户手填的量化标签与备注不应丢失", async () => {
    touch("main/a.gguf");
    addModel({ name: "m1", gguf_file: "main/a.gguf" });
    world.repo.createNamespace("shared");

    await listFileMeta(world.db, world.root); // 登记
    setFileMetaFields(world.db, world.root, "main/a.gguf", {
      quantLabel: "MyCustomQuant",
      mark: "生产用，勿删",
    });

    doMove("main/a.gguf", "shared");

    // 模型配置确实跟着走了（模块一自己的职责，应当通过）
    expect(world.repo.getModel("m1")?.gguf_file).toBe("shared/a.gguf");

    // 元信息应当跟随到新路径——这是「防止移动导致信息丢失」的立身之本
    const entries = await listFileMeta(world.db, world.root);
    const moved = entries.find((e) => e.path === "shared/a.gguf");
    expect(moved).toBeDefined();
    expect(moved?.quantLabel).toBe("MyCustomQuant");
    expect(moved?.mark).toBe("生产用，勿删");
  });

  it("改名后，用户手填的量化标签与备注不应丢失", async () => {
    touch("main/a.gguf");
    addModel({ name: "m1", gguf_file: "main/a.gguf" });

    await listFileMeta(world.db, world.root);
    setFileMetaFields(world.db, world.root, "main/a.gguf", {
      quantLabel: "MyCustomQuant",
      mark: "改名前的备注",
    });

    doRename("main/a.gguf", "renamed.gguf");

    expect(world.repo.getModel("m1")?.gguf_file).toBe("main/renamed.gguf");

    const entries = await listFileMeta(world.db, world.root);
    const renamed = entries.find((e) => e.path === "main/renamed.gguf");
    expect(renamed).toBeDefined();
    expect(renamed?.quantLabel).toBe("MyCustomQuant");
    expect(renamed?.mark).toBe("改名前的备注");
  });

  it("moveModel 换命名空间并移动文件后，元信息不应丢失", async () => {
    touch("main/a.gguf");
    addModel({ name: "m1", gguf_file: "main/a.gguf" });
    world.repo.createNamespace("lab");

    await listFileMeta(world.db, world.root);
    setFileMetaFields(world.db, world.root, "main/a.gguf", {
      quantLabel: "MyCustomQuant",
      mark: "moveModel 前的备注",
    });

    await world.ns.moveModel("m1", "lab", { moveFiles: true });

    const entries = await listFileMeta(world.db, world.root);
    const moved = entries.find((e) => e.path === "lab/a.gguf");
    expect(moved).toBeDefined();
    expect(moved?.quantLabel).toBe("MyCustomQuant");
    expect(moved?.mark).toBe("moveModel 前的备注");
  });
});

describe("file_meta 的逻辑条目粒度（设计 §3.1）", () => {
  it("分片组经 listFileMeta 登记应为一行 glob，而不是每个分片各一行", async () => {
    touch("main/m1-00001-of-00002.gguf");
    touch("main/m1-00002-of-00002.gguf");
    addModel({ name: "m1", gguf_file: "main/m1-*.gguf" });

    const entries = await listFileMeta(world.db, world.root);
    const paths = entries.map((e) => e.path).sort();

    // 设计 §3.1：一行 = 一个逻辑条目；分片组的 path 是 glob，与 gguf_file 字面一致
    expect(paths).toEqual(["main/m1-*.gguf"]);
  });
});

describe("移动不应作废已算出的完整哈希", () => {
  it("移动后 full_sha256 应保留（内容未变，只是换了位置）", async () => {
    touch("main/a.gguf");
    addModel({ name: "m1", gguf_file: "main/a.gguf" });
    world.repo.createNamespace("shared");

    await listFileMeta(world.db, world.root);
    // 模拟已播种/已手动算出的完整哈希
    world.db
      .prepare("UPDATE file_meta SET full_sha256 = ? WHERE path = ?")
      .run("f".repeat(64), "main/a.gguf");

    doMove("main/a.gguf", "shared");

    const entries = await listFileMeta(world.db, world.root);
    const moved = entries.find((e) => e.path === "shared/a.gguf");
    // 文件内容一个字节都没变，完整哈希不该因为换目录就作废重算
    expect(moved?.fullSha256).toBe("f".repeat(64));
  });
});

describe("分片组的自动寻找与重链（修复 listFileMeta 粒度后暴露的接缝）", () => {
  it("对分片组重链后，模型配置的 glob 应指向新位置", async () => {
    touch("main/m1-00001-of-00002.gguf", 32);
    touch("main/m1-00002-of-00002.gguf", 48);
    addModel({ name: "m1", gguf_file: "main/m1-*.gguf" });
    world.repo.createNamespace("lab");

    await listFileMeta(world.db, world.root); // 登记为一行 glob

    // 模拟面板之外的手工搬迁：文件挪走，配置还指着旧位置
    mkdirSync(path.join(world.root, "lab"), { recursive: true });
    for (const n of ["m1-00001-of-00002.gguf", "m1-00002-of-00002.gguf"]) {
      renameSync(path.join(world.root, "main", n), path.join(world.root, "lab", n));
    }

    relinkFile(world.db, world.root, "main/m1-*.gguf", "lab/m1-*.gguf");

    // 重链的意义就在于让配置重新指向文件；只搬 file_meta 不改配置等于没修好
    expect(world.repo.getModel("m1")?.gguf_file).toBe("lab/m1-*.gguf");
  });
});

describe("自定义镜像五字段的端到端串联（UI 草稿 → schema → 容器规格）", () => {
  it("用户在设置页填的五字段应真正影响容器启动参数", () => {
    addModel({ name: "m1", gguf_file: "main/a.gguf", mmproj_file: "main/a-mmproj.gguf" });

    // 1) 设置页的草稿（T6 的 CustomDraft 形态）
    const patch = draftToPatch({
      model_mount: "/mnt/models",
      entrypoint: ["/custom/llama-server"],
      extra_args: ["--verbose"],
      args_override: [],
      env: ["MY_FLAG=1"],
    });

    // 2) 经 PUT /api/v1/settings/default_config 的同款 schema 校验落库
    const base = createModelRepo(world.db).getDefaultConfig();
    const defaults = defaultConfigSchema.parse({
      ...base,
      docker: { ...base.docker, ...patch },
    });

    // 3) 启动时的容器规格组装（T5 的 buildContainerSpec）
    const spec = buildContainerSpec(world.repo.getModel("m1")!, defaults, world.root);

    // model_mount 必须真的换掉 -m / --mmproj 的容器内前缀（§1.2 的修复要端到端成立）
    expect(spec.args[spec.args.indexOf("-m") + 1]).toBe("/mnt/models/main/a.gguf");
    expect(spec.args[spec.args.indexOf("--mmproj") + 1]).toBe("/mnt/models/main/a-mmproj.gguf");
    // extra_args 追加在生成参数之后
    expect(spec.args[spec.args.length - 1]).toBe("--verbose");
    // entrypoint 透传，env 合并
    expect(spec.entrypoint).toEqual(["/custom/llama-server"]);
    expect(spec.env).toContain("MY_FLAG=1");
  });

  it("args_override 整体取代生成参数，占位符按 model_mount 展开", () => {
    addModel({ name: "m1", gguf_file: "main/a.gguf" });

    const patch = draftToPatch({
      model_mount: "/data",
      entrypoint: [],
      extra_args: ["--ignored"],
      args_override: ["--model-path", "{{model_path}}", "--listen", "{{port}}"],
      env: [],
    });
    const base = createModelRepo(world.db).getDefaultConfig();
    const defaults = defaultConfigSchema.parse({ ...base, docker: { ...base.docker, ...patch } });
    const spec = buildContainerSpec(world.repo.getModel("m1")!, defaults, world.root);

    expect(spec.args).toEqual([
      "--model-path",
      "/data/main/a.gguf",
      "--listen",
      String(defaults.docker.container_port),
    ]);
    expect(spec.args).not.toContain("--ignored"); // args_override 已设时 extra_args 被忽略
  });
});

describe("共享引用与分片组在移动时的元信息迁移", () => {
  it("两个模型共享同一文件时，移动后元信息只迁移一次且标注不丢", async () => {
    touch("main/shared.gguf");
    addModel({ name: "m1", gguf_file: "main/shared.gguf" });
    addModel({ name: "m2", gguf_file: "main/shared.gguf" });
    world.repo.createNamespace("lab");

    await listFileMeta(world.db, world.root);
    setFileMetaFields(world.db, world.root, "main/shared.gguf", {
      quantLabel: "SharedQuant",
      mark: "两个模板共用",
    });

    doMove("main/shared.gguf", "lab");

    // 两个模型都改了（T1 的共享引用修复）
    expect(world.repo.getModel("m1")?.gguf_file).toBe("lab/shared.gguf");
    expect(world.repo.getModel("m2")?.gguf_file).toBe("lab/shared.gguf");

    // file_meta 只此一行，标注仍在
    const entries = await listFileMeta(world.db, world.root);
    const rows = entries.filter((e) => e.path === "lab/shared.gguf");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.quantLabel).toBe("SharedQuant");
    expect(rows[0]?.mark).toBe("两个模板共用");
  });

  it("分片组整组移动后，file_meta 的 glob 条目跟随且标注不丢", async () => {
    touch("main/m1-00001-of-00002.gguf", 32);
    touch("main/m1-00002-of-00002.gguf", 48);
    addModel({ name: "m1", gguf_file: "main/m1-*.gguf" });
    world.repo.createNamespace("lab");

    await listFileMeta(world.db, world.root);
    setFileMetaFields(world.db, world.root, "main/m1-*.gguf", {
      quantLabel: "ShardQuant",
      mark: "分片组备注",
    });

    doMove("main/m1-00001-of-00002.gguf", "lab"); // 选中任一分片 → 整组移动

    expect(world.repo.getModel("m1")?.gguf_file).toBe("lab/m1-*.gguf");

    const entries = await listFileMeta(world.db, world.root);
    const moved = entries.find((e) => e.path === "lab/m1-*.gguf");
    expect(moved?.quantLabel).toBe("ShardQuant");
    expect(moved?.mark).toBe("分片组备注");
    expect(entries.filter((e) => e.path.startsWith("lab/"))).toHaveLength(1); // 仍是一行 glob
  });
});
