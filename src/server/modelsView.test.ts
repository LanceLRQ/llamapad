import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, runMigrations } from "./db";
import { createMockDockerAdapter } from "./adapters/mock";
import { createModelRepo, type ModelRepo } from "./repo/models";
import type { ModelConfig } from "../core/schemas";
import { createRuntimeService, type RuntimeService } from "./runtime";
import { decorateModels, decorateRuntimeStatus, type ModelView } from "./modelsView";

/**
 * 模型列表装配层测试（M1 Task 7，TDD）
 *
 * 搭建与 runtime.test.ts 同款：:memory: 库 + tmp models 根 + mock 适配器 +
 * createRuntimeService（host/panel 根合一）。四个状态 + 分片 glob 求和场景：
 * - running：runtime 起容器后 label 命中
 * - ready：文件齐全
 * - missing-file：gguf（精确路径）不存在 → sizeBytes 0
 * - missing-mmproj：gguf 在、mmproj 配置了但缺失 → size 只算 gguf
 * - 分片 glob：main/shard-*.gguf 三片 → sizeBytes 求和、fileCount 3、quant 取自分片名
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

async function views(): Promise<ModelView[]> {
  return decorateModels(world.db, world.runtime, world.root);
}

function byName(list: ModelView[], name: string): ModelView {
  const hit = list.find((m) => m.name === name);
  if (!hit) throw new Error(`测试断言失败：找不到模型 ${name}`);
  return hit;
}

beforeEach(() => {
  const db = openDb(":memory:");
  runMigrations(db);
  const root = mkdtempSync(path.join(tmpdir(), "llamapad-modelsview-"));
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

describe("decorateModels", () => {
  it("四态覆盖：running > missing-file > missing-mmproj > ready，running 优先于文件检查", async () => {
    touch("main/run.gguf", 10);
    touch("main/ok.gguf", 20);
    addModel({ name: "gone", gguf_file: "main/gone.gguf" });
    addModel({ name: "mm", gguf_file: "main/ok.gguf", mmproj_file: "main/mmproj-missing.gguf" });
    addModel({ name: "ok", gguf_file: "main/ok.gguf" });
    addModel({ name: "run-me", gguf_file: "main/run.gguf" });

    // 未启动前：ready / missing-file / missing-mmproj
    let list = await views();
    expect(byName(list, "ok").status).toBe("ready");
    expect(byName(list, "gone").status).toBe("missing-file");
    expect(byName(list, "mm").status).toBe("missing-mmproj");

    // 启动后：run-me → running（其余不变）
    await world.runtime.startModel("run-me");
    list = await views();
    expect(byName(list, "run-me").status).toBe("running");
    expect(byName(list, "ok").status).toBe("ready");

    // running 优先级最高：把 gguf 删掉，运行中的模型仍报 running
    rmSync(path.join(world.root, "main/run.gguf"));
    list = await views();
    expect(byName(list, "run-me").status).toBe("running");
  });

  it("sizeBytes / fileCount：分片 glob 求和与计数，missing 时 0", async () => {
    touch("main/shard-00001-of-00003.Q4_K_M.gguf", 100);
    touch("main/shard-00002-of-00003.Q4_K_M.gguf", 200);
    touch("main/shard-00003-of-00003.Q4_K_M.gguf", 300);
    touch("main/single.gguf", 42);
    addModel({ name: "sharded", gguf_file: "main/shard-*.gguf" });
    addModel({ name: "single", gguf_file: "main/single.gguf" });
    addModel({ name: "gone", gguf_file: "main/gone.gguf" });

    const list = await views();
    expect(byName(list, "sharded").sizeBytes).toBe(600);
    expect(byName(list, "sharded").fileCount).toBe(3);
    expect(byName(list, "single").sizeBytes).toBe(42);
    expect(byName(list, "single").fileCount).toBe(1);
    expect(byName(list, "gone").sizeBytes).toBe(0);
    expect(byName(list, "gone").fileCount).toBe(0);
  });

  it("quant：detectQuant 于分片文件名（优先）与配置路径（文件缺失时兜底）", async () => {
    touch("main/gemma-27b.Q8_0.gguf");
    addModel({ name: "sharded", gguf_file: "main/shard-*.gguf" }); // 不存在
    addModel({ name: "gemma", gguf_file: "main/gemma-27b.Q8_0.gguf" });
    addModel({ name: "plain", gguf_file: "main/plain.gguf" });
    touch("main/plain.gguf");

    const list = await views();
    expect(byName(list, "sharded").quant).toBeNull(); // glob 路径无量化 token 且零命中
    expect(byName(list, "gemma").quant).toBe("Q8_0");
    expect(byName(list, "plain").quant).toBeNull();
  });

  it("hostPort：默认 18080，模型级 overrides.docker.host_port 覆盖生效", async () => {
    touch("main/a.gguf");
    addModel({ name: "default-port" });
    addModel({
      name: "custom-port",
      overrides: { docker: { host_port: 18099 } },
    });

    const list = await views();
    expect(byName(list, "default-port").hostPort).toBe(18080);
    expect(byName(list, "custom-port").hostPort).toBe(18099);
  });

  it("基础字段透传：name/display_name/namespace/mmproj 配置，按 name 排序", async () => {
    touch("ns2/v.gguf");
    touch("main/a.gguf");
    world.repo.createNamespace("ns2");
    addModel({
      name: "beta",
      display_name: "Beta 模型",
      gguf_file: "main/a.gguf",
      mmproj_file: "main/a-mm.gguf",
    });
    world.repo.createModel({
      name: "alpha",
      display_name: "Alpha",
      namespace: "ns2",
      gguf_file: "ns2/v.gguf",
      overrides: {},
    });

    const list = await views();
    expect(list.map((m) => m.name)).toEqual(["alpha", "beta"]); // listModels 按 name 排序
    expect(byName(list, "beta").displayName).toBe("Beta 模型");
    expect(byName(list, "beta").namespace).toBe("main");
    expect(byName(list, "beta").mmprojFile).toBe("main/a-mm.gguf");
    expect(byName(list, "alpha").namespace).toBe("ns2");
    expect(byName(list, "alpha").mmprojFile).toBeNull(); // 未配置 → null（可序列化）
  });

  it("panel 根不存在：不抛错，全部按 missing-file（fsScanner ENOENT 容错）", async () => {
    addModel({ name: "a" });

    const list = await decorateModels(
      world.db,
      world.runtime,
      path.join(world.root, "no-such-root"),
    );
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe("missing-file");
    expect(list[0].sizeBytes).toBe(0);
  });
});

describe("decorateRuntimeStatus（M1 Task 9：概览 / 顶栏 / runtime status API 共用）", () => {
  it("运行中：displayName/hostPort 补自模型行与 mergeConfig，container/startedAt 透传", async () => {
    touch("main/run.gguf", 10);
    addModel({
      name: "run-me",
      display_name: "运行中模型",
      gguf_file: "main/run.gguf",
      overrides: { docker: { host_port: 18099 } },
    });
    await world.runtime.startModel("run-me");

    const status = await decorateRuntimeStatus(world.db, world.runtime);

    expect(status.running).not.toBeNull();
    expect(status.running!.model).toBe("run-me");
    expect(status.running!.displayName).toBe("运行中模型");
    expect(status.running!.container).toBe("llama-server"); // 内置默认容器名
    expect(status.running!.startedAt).not.toBeNull();
    expect(status.running!.hostPort).toBe(18099); // overrides 覆盖默认 18080
  });

  it("未运行：{ running: null }", async () => {
    const status = await decorateRuntimeStatus(world.db, world.runtime);
    expect(status).toEqual({ running: null });
  });

  it("模型行已删（容器在跑但配置没了）：displayName 退回模型名、hostPort null", async () => {
    touch("main/run.gguf", 10);
    addModel({ name: "ghost", gguf_file: "main/run.gguf" });
    await world.runtime.startModel("ghost");
    world.repo.deleteModel("ghost");

    const status = await decorateRuntimeStatus(world.db, world.runtime);

    expect(status.running!.model).toBe("ghost");
    expect(status.running!.displayName).toBe("ghost");
    expect(status.running!.hostPort).toBeNull();
  });
});
