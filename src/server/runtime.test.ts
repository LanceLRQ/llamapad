import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, runMigrations } from "./db";
import { createMockDockerAdapter, type MockDockerAdapter } from "./adapters/mock";
import type { DockerAdapter } from "./adapters/types";
import { createModelRepo, type ModelRepo } from "./repo/models";
import type { ModelConfig } from "../core/schemas";
import { buildContainerSpec, createRuntimeService, type RuntimeService } from "./runtime";

/**
 * 运行时服务层测试（M1 Task 6，TDD）
 *
 * 搭建：:memory: 库 + createModelRepo + createMockDockerAdapter；host/panel
 * 两个 models 根用同一个 tmp 目录（生产中前者用于 docker bind、后者用于文件检查，
 * 此处合一不影响覆盖）。假 gguf 文件真实落盘（writeFileSync "x"），
 * "谁是当前运行模型"的断言全部走容器 label（specOf / list），不依赖内存状态。
 */

interface World {
  db: Database.Database;
  repo: ModelRepo;
  adapter: MockDockerAdapter;
  runtime: RuntimeService;
  root: string;
}

let world: World;

/** 在临时 models 根下写一个内容为 "x" 的假文件（父目录自动创建） */
function touch(rel: string): void {
  const abs = path.join(world.root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, "x");
}

/** 建模型（display_name 缺省取 name、gguf 缺省指向已存在的 main/a.gguf） */
function addModel(partial: Partial<ModelConfig> & { name: string }): void {
  world.repo.createModel({
    display_name: partial.name,
    namespace: "main",
    gguf_file: "main/a.gguf",
    overrides: {},
    ...partial,
  });
}

/** 按写入顺序取全部事件 */
function events(): { id: number; kind: string; message: string }[] {
  return world.db
    .prepare("SELECT id, kind, message FROM events ORDER BY id")
    .all() as { id: number; kind: string; message: string }[];
}

beforeEach(() => {
  const db = openDb(":memory:");
  runMigrations(db);
  const root = mkdtempSync(path.join(tmpdir(), "llamapad-runtime-"));
  const adapter = createMockDockerAdapter();
  world = {
    db,
    repo: createModelRepo(db),
    adapter,
    runtime: createRuntimeService(db, adapter, root, root),
    root,
  };
  touch("main/a.gguf");
  touch("main/b.gguf");
});

afterEach(() => {
  world.db.close();
  rmSync(world.root, { recursive: true, force: true });
});

describe("buildContainerSpec：纯组装", () => {
  it("默认组装：volume 用 host 根、name/image/端口来自合并配置、labels 标记归属、args 以 -m 起头且不带 --mmproj", () => {
    addModel({ name: "a" });

    const spec = buildContainerSpec(
      world.repo.getModel("a")!,
      world.repo.getDefaultConfig(),
      world.root,
    );

    expect(spec.volume).toBe(`${world.root}:/models`);
    expect(spec.name).toBe("llama-server");
    expect(spec.image).toBe("ghcr.io/ggml-org/llama.cpp:server-cuda");
    expect(spec.hostPort).toBe(18080);
    expect(spec.containerPort).toBe(8080);
    expect(spec.gpu).toBe("all");
    expect(spec.labels).toEqual({ "llamapad.managed": "true", "llamapad.model": "a" });
    expect(spec.args[0]).toBe("-m");
    expect(spec.args[1]).toBe("/models/main/a.gguf");
    expect(spec.args).toContain("--port");
    expect(spec.args).not.toContain("--mmproj");
  });

  it("覆盖优先：docker.model_volume / docker.container_name 的模型级覆盖生效", () => {
    addModel({
      name: "a",
      overrides: { docker: { model_volume: "/data/big:/models", container_name: "a-box" } },
    });

    const spec = buildContainerSpec(
      world.repo.getModel("a")!,
      world.repo.getDefaultConfig(),
      world.root,
    );

    expect(spec.volume).toBe("/data/big:/models");
    expect(spec.name).toBe("a-box");
  });

  it("mmproj 配置存在时按同规则传 --mmproj 容器内路径", () => {
    addModel({ name: "mm", mmproj_file: "main/a-mmproj.gguf" });

    const spec = buildContainerSpec(
      world.repo.getModel("mm")!,
      world.repo.getDefaultConfig(),
      world.root,
    );

    const i = spec.args.indexOf("--mmproj");
    expect(i).toBeGreaterThan(-1);
    expect(spec.args[i + 1]).toBe("/models/main/a-mmproj.gguf");
  });

  it("PANEL_DEBUG_ARGS 钩子：非 production 时 args 整体替换为 sh -c；production 下忽略", () => {
    addModel({ name: "a" });
    const model = world.repo.getModel("a")!;
    const defaults = world.repo.getDefaultConfig();
    // NODE_ENV 在 @types/node 中为只读属性，测试内经宽化引用改写（还原在 finally）
    const env = process.env as Record<string, string | undefined>;
    const savedDebug = env.PANEL_DEBUG_ARGS;
    const savedNodeEnv = env.NODE_ENV;
    try {
      env.PANEL_DEBUG_ARGS = "echo panel-debug";
      // vitest 默认 NODE_ENV=test（非 production）→ 钩子生效
      expect(buildContainerSpec(model, defaults, world.root).args).toEqual([
        "sh",
        "-c",
        "echo panel-debug",
      ]);

      env.NODE_ENV = "production";
      expect(buildContainerSpec(model, defaults, world.root).args[0]).toBe("-m");
    } finally {
      if (savedDebug === undefined) delete env.PANEL_DEBUG_ARGS;
      else env.PANEL_DEBUG_ARGS = savedDebug;
      if (savedNodeEnv === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = savedNodeEnv;
    }
  });
});

describe("startModel", () => {
  it("模型不存在 → 抛「模型不存在」", async () => {
    await expect(world.runtime.startModel("nope")).rejects.toThrow("模型不存在");
    expect(events()).toEqual([]);
  });

  it("gguf 或 mmproj 任一缺失 → 抛「模型文件缺失」并含相对路径", async () => {
    addModel({ name: "c", gguf_file: "main/c.gguf" }); // gguf 不存在
    addModel({ name: "d", mmproj_file: "main/d-mm.gguf" }); // gguf 在、mmproj 不存在

    await expect(world.runtime.startModel("c")).rejects.toThrow(/模型文件缺失/);
    await expect(world.runtime.startModel("c")).rejects.toThrow("main/c.gguf");
    await expect(world.runtime.startModel("d")).rejects.toThrow("模型文件缺失");
    await expect(world.runtime.startModel("d")).rejects.toThrow("main/d-mm.gguf");
    expect(events()).toEqual([]); // 启动前校验失败不产生任何启停事件
  });

  it("成功：mock 起容器（label / volume / args[0]），events 记 model.start（message 含模型名）", async () => {
    addModel({ name: "a" });

    const { id } = await world.runtime.startModel("a");

    expect(id).toMatch(/^mock-/);
    const spec = world.adapter.specOf("llama-server");
    expect(spec).not.toBeNull();
    expect(spec!.labels).toEqual({ "llamapad.managed": "true", "llamapad.model": "a" });
    expect(spec!.volume).toBe(`${world.root}:/models`);
    expect(spec!.args[0]).toBe("-m");
    expect(spec!.args[1]).toBe("/models/main/a.gguf");

    const rows = events();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("model.start");
    expect(rows[0].message).toContain("a");
  });

  it("单模型切换：起 a 后再起 b → a 的容器先被停掉（mock 中消失）、b running；事件顺序 stop(a,切换)→start(b)", async () => {
    addModel({ name: "a", overrides: { docker: { container_name: "a-box" } } });
    addModel({ name: "b" });

    await world.runtime.startModel("a");
    await world.runtime.startModel("b");

    expect(world.adapter.specOf("a-box")).toBeNull(); // a 的容器已消失
    const specB = world.adapter.specOf("llama-server");
    expect(specB!.labels!["llamapad.model"]).toBe("b"); // b running

    const rows = events();
    expect(rows.map((r) => r.kind)).toEqual(["model.start", "model.stop", "model.start"]);
    expect(rows[1].message).toContain("a");
    expect(rows[1].message).toContain("切换");
    expect(rows[2].message).toContain("b");
  });

  it("start 失败：events 记 model.start_failed（message 含失败原因摘要），错误继续上抛", async () => {
    addModel({ name: "a" });
    const failing: DockerAdapter = {
      ...world.adapter,
      start: () => Promise.reject(new Error("docker daemon 不可达")),
    };
    const runtime = createRuntimeService(world.db, failing, world.root, world.root);

    await expect(runtime.startModel("a")).rejects.toThrow("docker daemon 不可达");

    const rows = events();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("model.start_failed");
    expect(rows[0].message).toContain("a");
    expect(rows[0].message).toContain("docker daemon 不可达");
  });

  it("同名模型重复 start → 先停旧容器再起新的（recreate），events 记 model.stop（重建）", async () => {
    addModel({ name: "a" });

    const first = await world.runtime.startModel("a");
    const second = await world.runtime.startModel("a");

    expect(second.id).not.toBe(first.id); // 旧容器被替换，新容器新 id
    expect(world.adapter.specOf("llama-server")!.labels!["llamapad.model"]).toBe("a");

    const rows = events();
    expect(rows.map((r) => r.kind)).toEqual(["model.start", "model.stop", "model.start"]);
    expect(rows[1].message).toContain("a");
    expect(rows[1].message).toContain("重建");
  });
});

describe("stopModel", () => {
  it("该模型无容器 → 幂等成功且不写事件（取舍：events 只记状态变化，避免轮询/重复调用刷表）", async () => {
    addModel({ name: "a" });

    await expect(world.runtime.stopModel("a")).resolves.toBeUndefined();
    expect(events()).toEqual([]);
  });

  it("运行中 → 停掉容器 + events 记 model.stop", async () => {
    addModel({ name: "a" });
    await world.runtime.startModel("a");

    await world.runtime.stopModel("a");

    expect(world.adapter.specOf("llama-server")).toBeNull();
    expect(await world.runtime.getRuntimeStatus()).toEqual({ running: null });
    const rows = events();
    expect(rows.map((r) => r.kind)).toEqual(["model.start", "model.stop"]);
    expect(rows[1].message).toContain("a");
  });
});

describe("restartModel", () => {
  it("= stop + start：事件各记一条，stop 的 message 标注重启", async () => {
    addModel({ name: "a" });
    await world.runtime.startModel("a");

    const restarted = await world.runtime.restartModel("a");

    expect(restarted.id).toMatch(/^mock-/);
    const status = await world.runtime.getRuntimeStatus();
    expect(status.running?.model).toBe("a");
    expect(status.running?.container).toBe("llama-server");

    const rows = events();
    expect(rows.map((r) => r.kind)).toEqual(["model.start", "model.stop", "model.start"]);
    expect(rows[1].message).toContain("a");
    expect(rows[1].message).toContain("重启");
  });

  it("未运行时 restart 等价于直接 start（stop 幂等无事件）", async () => {
    addModel({ name: "b" });

    await world.runtime.restartModel("b");

    expect(events().map((r) => r.kind)).toEqual(["model.start"]);
  });
});

describe("getRuntimeStatus", () => {
  it("无托管容器 → running:null；运行中 → 从 label 推导；多命中异常态取第一个并加 warning:multiple", async () => {
    addModel({ name: "a" });
    addModel({ name: "b" });

    expect(await world.runtime.getRuntimeStatus()).toEqual({ running: null });

    await world.runtime.startModel("a");
    const status = await world.runtime.getRuntimeStatus();
    expect(status.running?.model).toBe("a");
    expect(status.running?.container).toBe("llama-server");
    expect(typeof status.running?.startedAt).toBe("string");
    expect(status.warning).toBeUndefined();

    // 异常态：手工注入第二个托管容器（不同容器名、b 的 label），list 顺序 a 在前
    const intruder = buildContainerSpec(
      world.repo.getModel("b")!,
      world.repo.getDefaultConfig(),
      world.root,
    );
    await world.adapter.start({ ...intruder, name: "intruder-box" });

    const multi = await world.runtime.getRuntimeStatus();
    expect(multi.warning).toBe("multiple");
    expect(multi.running?.model).toBe("a"); // 不抛错，如实取第一个
  });
});
