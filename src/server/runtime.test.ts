import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, runMigrations } from "./db";
import { createMockDockerAdapter, type MockDockerAdapter } from "./adapters/mock";
import type { DockerAdapter } from "./adapters/types";
import { createModelRepo, type ModelRepo } from "./repo/models";
import type { ModelConfig } from "../core/schemas";
import { buildGguf } from "../core/gguf.testkit";
import { METRIC_IDS } from "./metrics/ids";
import {
  buildContainerSpec,
  createRuntimeService,
  getRunningContainerInfo,
  ReasoningEffortNotAllowedError,
  RuntimeBusyError,
  type RuntimeDeps,
  type RuntimeService,
} from "./runtime";

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

/** run 表行（测试用窄类型，字段对齐 migrations v7 的 runs 表） */
interface RunRow {
  id: number;
  model: string;
  started_at: number;
  ended_at: number | null;
  end_reason: string | null;
  avg_tokens_per_sec: number | null;
  peak_tokens_per_sec: number | null;
  peak_gpu_mem_mib: number | null;
  baseline_gpu_mem_mib: number | null;
  gpu_mem_total_mib: number | null;
}

/** 按写入顺序（id 升序）取全部 run 行 */
function runs(): RunRow[] {
  return world.db.prepare("SELECT * FROM runs ORDER BY id").all() as RunRow[];
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

  it("--alias 透传面板模型名（llama-server 用它覆盖 /v1/models 的 id 与 chat 响应的 model 字段）", () => {
    addModel({ name: "a" });

    const spec = buildContainerSpec(
      world.repo.getModel("a")!,
      world.repo.getDefaultConfig(),
      world.root,
    );

    const i = spec.args.indexOf("--alias");
    expect(spec.args[i + 1]).toBe("a");
  });

  it("enable_thinking 不再注入内置 env（上游改名致其失效，已改走 args.ts 的 --chat-template-kwargs CLI 参数）", () => {
    addModel({ name: "think-off", overrides: { server: { enable_thinking: false } } });
    addModel({ name: "think-on", overrides: { server: { enable_thinking: true } } });

    const off = buildContainerSpec(
      world.repo.getModel("think-off")!,
      world.repo.getDefaultConfig(),
      world.root,
    );
    const on = buildContainerSpec(
      world.repo.getModel("think-on")!,
      world.repo.getDefaultConfig(),
      world.root,
    );

    // 未配置用户 docker.env 时不再产出 env 字段（内置注入已移除）
    expect(off.env).toBeUndefined();
    expect(on.env).toBeUndefined();
    // enable_thinking 改经 args 的 --chat-template-kwargs 传递（buildArgs 职责，覆盖见 args.test.ts）
    expect(off.args).toContain("--chat-template-kwargs");
    expect(on.args).toContain("--chat-template-kwargs");
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

  // ---------- 自定义镜像逃生口（§5.6）：model_mount / extra_args / args_override / env ----------

  it("model_mount 覆盖为非默认值时，-m 与 --mmproj 的容器内路径跟着变（§1.2 回归锁）", () => {
    addModel({
      name: "a",
      mmproj_file: "main/a-mmproj.gguf",
      overrides: { docker: { model_mount: "/mnt/models" } },
    });

    const spec = buildContainerSpec(
      world.repo.getModel("a")!,
      world.repo.getDefaultConfig(),
      world.root,
    );

    expect(spec.args[0]).toBe("-m");
    expect(spec.args[1]).toBe("/mnt/models/main/a.gguf");
    const i = spec.args.indexOf("--mmproj");
    expect(spec.args[i + 1]).toBe("/mnt/models/main/a-mmproj.gguf");
  });

  it("extra_args 追加在生成参数之后", () => {
    addModel({ name: "a", overrides: { docker: { extra_args: ["--foo", "bar"] } } });

    const spec = buildContainerSpec(
      world.repo.getModel("a")!,
      world.repo.getDefaultConfig(),
      world.root,
    );

    expect(spec.args.slice(-2)).toEqual(["--foo", "bar"]);
    // 生成参数仍在，未被取代
    expect(spec.args[0]).toBe("-m");
    expect(spec.args).toContain("--ctx-size");
  });

  it("args_override 已设置时整体取代生成参数，占位符按 model_mount 替换；extra_args 被忽略", () => {
    addModel({
      name: "a",
      mmproj_file: "main/a-mmproj.gguf",
      overrides: {
        docker: {
          model_mount: "/data",
          args_override: [
            "--model-path",
            "{{model_path}}",
            "--mmproj-path",
            "{{mmproj_path}}",
            "--listen-port",
            "{{port}}",
          ],
          extra_args: ["--should-be-ignored"],
        },
      },
    });

    const spec = buildContainerSpec(
      world.repo.getModel("a")!,
      world.repo.getDefaultConfig(),
      world.root,
    );

    expect(spec.args).toEqual([
      "--model-path",
      "/data/main/a.gguf",
      "--mmproj-path",
      "/data/main/a-mmproj.gguf",
      "--listen-port",
      "8080",
    ]);
  });

  it("args_override 下 mmproj 未配置时 {{mmproj_path}} 替换为空串，该项被丢弃", () => {
    addModel({
      name: "a",
      overrides: {
        docker: { args_override: ["-m", "{{model_path}}", "--mmproj", "{{mmproj_path}}"] },
      },
    });

    const spec = buildContainerSpec(
      world.repo.getModel("a")!,
      world.repo.getDefaultConfig(),
      world.root,
    );

    expect(spec.args).toEqual(["-m", "/models/main/a.gguf", "--mmproj"]);
  });

  it("env 只透传用户 docker.env（内置注入已移除，原样保留、不追加任何内置项）", () => {
    addModel({
      name: "a",
      overrides: {
        docker: { env: ["LLAMA_CHAT_TEMPLATE_KWARGS=custom", "EXTRA_VAR=1"] },
      },
    });

    const spec = buildContainerSpec(
      world.repo.getModel("a")!,
      world.repo.getDefaultConfig(),
      world.root,
    );

    expect(spec.env).toEqual(["LLAMA_CHAT_TEMPLATE_KWARGS=custom", "EXTRA_VAR=1"]);
  });

  it("entrypoint 透传进 ContainerSpec；未设置时为 undefined", () => {
    addModel({ name: "a" });
    addModel({ name: "b", overrides: { docker: { entrypoint: ["/bin/sh", "-c"] } } });

    const defaults = world.repo.getDefaultConfig();
    expect(buildContainerSpec(world.repo.getModel("a")!, defaults, world.root).entrypoint).toBeUndefined();
    expect(buildContainerSpec(world.repo.getModel("b")!, defaults, world.root).entrypoint).toEqual([
      "/bin/sh",
      "-c",
    ]);
  });
});

describe("startModel", () => {
  it("模型不存在 → 抛「模型不存在」", async () => {
    await expect(world.runtime.startModel("nope")).rejects.toThrow("模型不存在");
    expect(events()).toEqual([]);
  });

  it("hostModelsRoot 为空串且未覆盖 model_volume → 抛「宿主机路径未解析」，不触碰现有容器", async () => {
    addModel({ name: "a" });
    const runtime = createRuntimeService(world.db, world.adapter, "", world.root);

    await expect(runtime.startModel("a")).rejects.toThrow(/models 宿主机路径未解析/);
    await expect(runtime.startModel("a")).rejects.toThrow("PANEL_MODELS_HOST");
    await expect(runtime.startModel("a")).rejects.toThrow("paths.models.host");
    expect(events()).toEqual([]); // 启动前校验失败不产生任何启停事件，也没有 docker 调用
  });

  it("hostModelsRoot 仅空白字符（trim 后为空）同样判定为未解析", async () => {
    addModel({ name: "a" });
    const runtime = createRuntimeService(world.db, world.adapter, "   ", world.root);

    await expect(runtime.startModel("a")).rejects.toThrow(/models 宿主机路径未解析/);
  });

  it("即便 hostModelsRoot 为空，model_volume 覆盖存在时不该被误伤（不抛错）", async () => {
    addModel({ name: "a", overrides: { docker: { model_volume: "/data/models:/models" } } });
    const runtime = createRuntimeService(world.db, world.adapter, "", world.root);

    const { id } = await runtime.startModel("a");

    expect(id).toMatch(/^mock-/);
    expect(world.adapter.specOf("llama-server")?.volume).toBe("/data/models:/models");
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

// ---------- reasoning_effort 前置校验（真机复现的缺陷）----------
//
// 值域外的 reasoning_effort 不会被 zod 挡下（schema 只校验字符串本身，不知道
// "这个模型的 chat template 认哪些值"）：API 直接 PUT /api/v1/models/<name> 或
// YAML 导入都能绕过 edit-form.tsx 的 onSave 校验，容器会照常启动、/health 照常
// 200，只有真正发一次推理请求时才从 jinja 里炸出 500——必须在启动前挡，且必须
// 挡在 stopManagedBeforeStart 之前（校验失败不能有副作用，不能先把正在跑的
// 模型停了再报错，见 runtime.ts startModel 头部注释）。
describe("startModel：reasoning_effort 前置校验", () => {
  // Qwen3.8 系列真实片段：值域 xhigh/medium/low，reasoning_effort 分支整段包在
  // enable_thinking 判断内（与 lib/reasoning-effort.ts 头部文档描述的场景一致）
  const TEMPLATE = `
{%- if enable_thinking is undefined or enable_thinking is true %}
    {%- set resolved_reasoning_effort = reasoning_effort|default('xhigh') %}
    {%- if resolved_reasoning_effort not in ('xhigh', 'medium', 'low') %}
        {{- raise_exception('Unexpected reasoning effort ') }}
    {%- endif %}
{%- endif %}
`;

  /** 覆盖 beforeEach 里 touch() 写的占位假文件，换成带上述模板的真实可解析 GGUF */
  function touchWithChatTemplate(rel: string): void {
    const abs = path.join(world.root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(
      abs,
      buildGguf([
        ["general.architecture", { t: 8, v: "qwen3" }],
        ["tokenizer.chat_template", { t: 8, v: TEMPLATE }],
      ]),
    );
  }

  it("值域外的值 → 抛 ReasoningEffortNotAllowedError，且不产生任何副作用（正在运行的容器未被停掉）", async () => {
    touchWithChatTemplate("main/a.gguf");
    addModel({ name: "a", overrides: { server: { reasoning_effort: "max" } } });
    addModel({ name: "b" });
    await world.runtime.startModel("b"); // 先让 b 跑起来，充当"正在运行的模型"

    await expect(world.runtime.startModel("a")).rejects.toBeInstanceOf(ReasoningEffortNotAllowedError);

    // 位置约束的意义：校验必须挡在 stopManagedBeforeStart 之前，b 的容器不该被停掉
    expect(world.adapter.specOf("llama-server")?.labels?.["llamapad.model"]).toBe("b");
    expect(events().map((r) => r.kind)).toEqual(["model.start"]); // 只有 b 的 start，没有任何 a 相关事件
  });

  it("错误信息带上该模型允许的档位", async () => {
    touchWithChatTemplate("main/a.gguf");
    addModel({ name: "a", overrides: { server: { reasoning_effort: "max" } } });

    await expect(world.runtime.startModel("a")).rejects.toThrow(/xhigh/);
    await expect(world.runtime.startModel("a")).rejects.toThrow(/medium/);
    await expect(world.runtime.startModel("a")).rejects.toThrow(/low/);
  });

  it('"inherit" 直接放行，不读 GGUF（占位假文件无合法模板也不受影响）', async () => {
    addModel({ name: "a", overrides: { server: { reasoning_effort: "inherit" } } });

    await expect(world.runtime.startModel("a")).resolves.toBeDefined();
  });

  it("合法值（在模板值域内）→ 放行", async () => {
    touchWithChatTemplate("main/a.gguf");
    addModel({ name: "a", overrides: { server: { reasoning_effort: "medium" } } });

    await expect(world.runtime.startModel("a")).resolves.toBeDefined();
  });

  it("现有假 gguf 文件（无 chat template）→ 判定 unknown 一律放行，不误伤既有用例", async () => {
    addModel({ name: "a", overrides: { server: { reasoning_effort: "max" } } }); // 沿用 beforeEach 的占位假文件

    await expect(world.runtime.startModel("a")).resolves.toBeDefined();
  });

  it("restart 一个正在运行、且被直接写入非法配置的模型 → 抛 ReasoningEffortNotAllowedError，容器仍在运行（未被 stopByName 停掉）", async () => {
    // 对称锁：与上面「start 无副作用」那条对应——restartModel 内部虽然也调用
    // startModel，但那次调用发生在 stopByName 之后，校验挡在 startModel 里等于
    // 没挡，必须在 restartModel 最开头单独校验一次（真机复现的缺口，见
    // assertReasoningEffortAllowed 头部注释）
    touchWithChatTemplate("main/a.gguf");
    addModel({ name: "a" }); // 先以合法默认配置（inherit）启动
    await world.runtime.startModel("a");
    // 模拟「API 直接 PUT 写入非法值」绕过表单校验：模型仍在运行，配置已改坏
    world.repo.updateModel("a", { overrides: { server: { reasoning_effort: "max" } } });

    await expect(world.runtime.restartModel("a")).rejects.toBeInstanceOf(ReasoningEffortNotAllowedError);

    expect(world.adapter.specOf("llama-server")?.labels?.["llamapad.model"]).toBe("a"); // 容器未被停掉
    expect(events().map((r) => r.kind)).toEqual(["model.start"]); // 只有最初的 start，没有任何 stop 事件
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

// ---------- 排空（drain）接线：切换/停止前等在途推理结束 ----------

describe("排空（drain）接线", () => {
  it("options 缺省（不传第二参）→ 即使 deps.waitForIdle 已注入也不会被调用，行为零变化", async () => {
    addModel({ name: "a" });
    addModel({ name: "b" });
    const waitForIdle = vi.fn(async () => ({ drained: true, reason: "idle" as const }));
    const runtime = createRuntimeService(world.db, world.adapter, world.root, world.root, { waitForIdle });

    await runtime.startModel("a");
    const started = await runtime.startModel("b");

    expect(waitForIdle).not.toHaveBeenCalled();
    expect(started).toEqual({ id: expect.any(String) }); // 无 drain 字段
  });

  it("options.drain=true 但 deps.waitForIdle 未注入 → 排空结果 skipped，仍照常停止", async () => {
    addModel({ name: "a", overrides: { docker: { container_name: "a-box" } } });
    addModel({ name: "b" });
    await world.runtime.startModel("a"); // world.runtime 未注入 waitForIdle

    const started = await world.runtime.startModel("b", { drain: true });

    expect(started.drain).toEqual({ drained: true, reason: "skipped" });
    expect(world.adapter.specOf("a-box")).toBeNull(); // 仍然照停不误
  });

  it("排空发生在 stop 之前（调用顺序）：waitForIdle → adapter.stop；成功后事件文案追加排空后缀", async () => {
    addModel({ name: "a", overrides: { docker: { container_name: "a-box" } } });
    addModel({ name: "b" });
    const order: string[] = [];
    const waitForIdle = vi.fn(async ({ hostPort, timeoutMs }: { hostPort: number; timeoutMs: number }) => {
      order.push(`waitForIdle:${hostPort}:${timeoutMs}`);
      return { drained: true, reason: "idle" as const };
    });
    const adapter: DockerAdapter = {
      ...world.adapter,
      stop: async (name) => {
        order.push(`stop:${name}`);
        await world.adapter.stop(name);
      },
    };
    const runtime = createRuntimeService(world.db, adapter, world.root, world.root, { waitForIdle });

    await runtime.startModel("a");
    const started = await runtime.startModel("b", { drain: true, drainTimeoutMs: 2_000 });

    expect(order).toEqual(["waitForIdle:18080:2000", "stop:a-box"]);
    expect(started.drain).toEqual({ drained: true, reason: "idle" });
    const stopRow = events().find((r) => r.kind === "model.stop")!;
    expect(stopRow.message).toContain("a");
    expect(stopRow.message).toContain("切换");
    expect(stopRow.message).toContain("排空"); // 只在排空发生的分支追加，不改既有文案默认形态
  });

  it("排空超时（reason:timeout）→ 仍然继续停止旧容器，不会被卡住", async () => {
    addModel({ name: "a", overrides: { docker: { container_name: "a-box" } } });
    addModel({ name: "b" });
    const waitForIdle = vi.fn(async () => ({ drained: false, reason: "timeout" as const }));
    const runtime = createRuntimeService(world.db, world.adapter, world.root, world.root, { waitForIdle });

    await runtime.startModel("a");
    const started = await runtime.startModel("b", { drain: true, drainTimeoutMs: 1_000 });

    expect(world.adapter.specOf("a-box")).toBeNull(); // 超时也照停不误
    expect(started.drain).toEqual({ drained: false, reason: "timeout" });
  });

  it("待停容器所属模型行已删除 → 拿不到 hostPort，排空 skipped 且不调用 waitForIdle", async () => {
    addModel({ name: "a" });
    addModel({ name: "b" });
    await world.runtime.startModel("a");
    world.repo.deleteModel("a"); // 容器仍在跑，但模型配置已删

    const waitForIdle = vi.fn(async () => ({ drained: true, reason: "idle" as const }));
    const runtime = createRuntimeService(world.db, world.adapter, world.root, world.root, { waitForIdle });

    const started = await runtime.startModel("b", { drain: true });

    expect(waitForIdle).not.toHaveBeenCalled();
    expect(started.drain).toEqual({ drained: true, reason: "skipped" });
  });

  it("冷启动（没有旧容器可停）传 drain:true → 仍返回 skipped，drain 字段不忽有忽无", async () => {
    addModel({ name: "a" });
    const waitForIdle = vi.fn(async () => ({ drained: true, reason: "idle" as const }));
    const runtime = createRuntimeService(world.db, world.adapter, world.root, world.root, { waitForIdle });

    const started = await runtime.startModel("a", { drain: true });

    expect(waitForIdle).not.toHaveBeenCalled(); // 没有在途推理可等
    expect(started.drain).toEqual({ drained: true, reason: "skipped" });
  });

  it("stopModel 对未运行模型传 drain:true → skipped（幂等停止路径同样守住契约）", async () => {
    addModel({ name: "a" });
    const waitForIdle = vi.fn(async () => ({ drained: true, reason: "idle" as const }));
    const runtime = createRuntimeService(world.db, world.adapter, world.root, world.root, { waitForIdle });

    await expect(runtime.stopModel("a", { drain: true })).resolves.toEqual({
      drained: true,
      reason: "skipped",
    });
    expect(waitForIdle).not.toHaveBeenCalled();
  });

  it("stopModel 传 drain:true → 返回值即 DrainOutcome（非 undefined）", async () => {
    addModel({ name: "a" });
    const waitForIdle = vi.fn(async () => ({ drained: true, reason: "idle" as const }));
    const runtime = createRuntimeService(world.db, world.adapter, world.root, world.root, { waitForIdle });
    await runtime.startModel("a");

    const result = await runtime.stopModel("a", { drain: true });

    expect(result).toEqual({ drained: true, reason: "idle" });
    expect(waitForIdle).toHaveBeenCalledTimes(1);
  });

  it("restartModel 传 drain:true → 返回值带 drain 字段（取自 stop 阶段的排空结果，start 阶段无旧容器不重复排空）", async () => {
    addModel({ name: "a" });
    const waitForIdle = vi.fn(async () => ({ drained: true, reason: "idle" as const }));
    const runtime = createRuntimeService(world.db, world.adapter, world.root, world.root, { waitForIdle });
    await runtime.startModel("a");

    const restarted = await runtime.restartModel("a", { drain: true });

    expect(restarted.drain).toEqual({ drained: true, reason: "idle" });
    expect(waitForIdle).toHaveBeenCalledTimes(1);
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

  it("迟退检测（M4 真机）：容器异常消失（非面板 stop）→ events 记 model.exit；面板停止不记", async () => {
    addModel({ name: "a" });
    const events = () => world.db.prepare("SELECT kind FROM events ORDER BY id").all() as { kind: string }[];

    // ---- 异常退出路径 ----
    await world.runtime.startModel("a");
    await world.runtime.getRuntimeStatus(); // 观察到 running=a
    world.adapter.crash("llama-server"); // 模拟启动成功后进程崩溃、容器消失

    const afterCrash = await world.runtime.getRuntimeStatus();
    expect(afterCrash.running).toBeNull();
    const kinds = events().map((r) => r.kind);
    expect(kinds).toContain("model.exit");

    // ---- 面板主动 stop 豁免 ----
    await world.runtime.startModel("a");
    await world.runtime.getRuntimeStatus();
    await world.runtime.stopModel("a");
    const afterStop = await world.runtime.getRuntimeStatus();

    expect(afterStop.running).toBeNull();
    const exitCount = events().filter((r) => r.kind === "model.exit").length;
    expect(exitCount).toBe(1); // 只有 crash 那次，stop 不新增
  });
});

// ---------- getRunningContainerInfo（M3 Task 2：指标采集的运行信息） ----------

describe("getRunningContainerInfo", () => {
  it("无托管容器 → null", async () => {
    await expect(getRunningContainerInfo(world.db, world.adapter)).resolves.toBeNull();
  });

  it("运行中 → 容器名 + 模型名 + mergeConfig(默认, overrides) 后的 host_port", async () => {
    addModel({ name: "a", overrides: { docker: { host_port: 19999 } } });
    await world.runtime.startModel("a");

    await expect(getRunningContainerInfo(world.db, world.adapter)).resolves.toEqual({
      container: "llama-server",
      model: "a",
      hostPort: 19999,
    });
  });

  it("模型行已删（容器还在跑）→ container/model 仍可用，hostPort 退化为 null", async () => {
    addModel({ name: "a" });
    await world.runtime.startModel("a");
    world.repo.deleteModel("a");

    await expect(getRunningContainerInfo(world.db, world.adapter)).resolves.toEqual({
      container: "llama-server",
      model: "a",
      hostPort: null,
    });
  });
});

// ---------- 运行历史记录（U17）：三记录点 + 悬空 run 对账 ----------

describe("运行历史：runs 表记录", () => {
  it("startModel 成功后 runs 表出现一条 ended_at IS NULL 的行，model 正确", async () => {
    addModel({ name: "a" });

    await world.runtime.startModel("a");

    const rows = runs();
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe("a");
    expect(rows[0].ended_at).toBeNull();
  });

  it("baseline 在 stopManagedBeforeStart 之后采样：旧容器的残留显存不计入新 run 的 baseline", async () => {
    addModel({ name: "a" });
    addModel({ name: "b" });
    let stopped = false;
    const adapter: DockerAdapter = {
      ...world.adapter,
      stop: async (name) => {
        await world.adapter.stop(name);
        stopped = true;
      },
    };
    const deps: RuntimeDeps = {
      getGpuMemUsedMib: () => (stopped ? 1000 : 9000),
      getGpuMemTotalMib: () => 24_000,
    };
    const runtime = createRuntimeService(world.db, adapter, world.root, world.root, deps);

    await runtime.startModel("a"); // 无旧容器可停，stop 未被调用
    await runtime.startModel("b"); // 切换：stopManagedBeforeStart 先停 a → stopped=true

    const rows = runs();
    const runB = rows.find((r) => r.model === "b")!;
    expect(runB.baseline_gpu_mem_mib).toBe(1000); // 证明采样发生在停旧容器之后，而非 9000
  });

  it("deps 完全不注入时不抛错，聚合值全为 null", async () => {
    addModel({ name: "a" });

    await expect(world.runtime.startModel("a")).resolves.toBeDefined();
    await expect(world.runtime.stopModel("a")).resolves.toBeUndefined();

    const row = runs()[0];
    expect(row.baseline_gpu_mem_mib).toBeNull();
    expect(row.gpu_mem_total_mib).toBeNull();
    expect(row.peak_gpu_mem_mib).toBeNull();
    expect(row.avg_tokens_per_sec).toBeNull();
    expect(row.peak_tokens_per_sec).toBeNull();
  });

  it("GPU 读数返回 null 时 baseline_gpu_mem_mib / gpu_mem_total_mib 写 NULL", async () => {
    addModel({ name: "a" });
    const deps: RuntimeDeps = { getGpuMemUsedMib: () => null, getGpuMemTotalMib: () => null };
    const runtime = createRuntimeService(world.db, world.adapter, world.root, world.root, deps);

    await runtime.startModel("a");

    const row = runs()[0];
    expect(row.baseline_gpu_mem_mib).toBeNull();
    expect(row.gpu_mem_total_mib).toBeNull();
  });

  it("stopModel 关闭 run 并记 end_reason=stopped", async () => {
    addModel({ name: "a" });
    await world.runtime.startModel("a");

    await world.runtime.stopModel("a");

    const row = runs()[0];
    expect(row.ended_at).not.toBeNull();
    expect(row.end_reason).toBe("stopped");
  });

  it("切换模型（起 A 再起 B）→ A 的 run 记 switched，B 开新 run", async () => {
    addModel({ name: "a" });
    addModel({ name: "b" });

    await world.runtime.startModel("a");
    await world.runtime.startModel("b");

    const rows = runs();
    expect(rows).toHaveLength(2);
    expect(rows[0].model).toBe("a");
    expect(rows[0].end_reason).toBe("switched");
    expect(rows[0].ended_at).not.toBeNull();
    expect(rows[1].model).toBe("b");
    expect(rows[1].ended_at).toBeNull();
  });

  it("同名重建（连起两次 A）→ 第一条记 recreated，第二条仍是运行中", async () => {
    addModel({ name: "a" });

    await world.runtime.startModel("a");
    await world.runtime.startModel("a");

    const rows = runs();
    expect(rows).toHaveLength(2);
    expect(rows[0].end_reason).toBe("recreated");
    expect(rows[0].ended_at).not.toBeNull();
    expect(rows[1].ended_at).toBeNull();
  });

  it("迟退检测触发时关闭 run 并记 exited", async () => {
    addModel({ name: "a" });
    await world.runtime.startModel("a");
    await world.runtime.getRuntimeStatus(); // 观察到 running=a

    world.adapter.crash("llama-server"); // 模拟启动成功后进程崩溃、容器消失
    await world.runtime.getRuntimeStatus();

    const row = runs()[0];
    expect(row.ended_at).not.toBeNull();
    expect(row.end_reason).toBe("exited");
  });

  it("closeRun 聚合：peakGpuMemMib 取 gpu.mem_used_mib 的 max，avg/peakTokensPerSec 取 infer.tokens_per_sec", async () => {
    addModel({ name: "a" });
    const calls: { metric: string; from: number; to: number }[] = [];
    const deps: RuntimeDeps = {
      getGpuMemUsedMib: () => 500,
      getGpuMemTotalMib: () => 24_000,
      aggregate: (metric, from, to) => {
        calls.push({ metric, from, to });
        if (metric === METRIC_IDS.gpuMemUsedMib) return { max: 2000, avg: 1000, count: 10 };
        if (metric === METRIC_IDS.inferTokensPerSec) return { max: 50, avg: 30, count: 10 };
        return null;
      },
    };
    const runtime = createRuntimeService(world.db, world.adapter, world.root, world.root, deps);

    await runtime.startModel("a");
    await runtime.stopModel("a");

    const row = runs()[0];
    expect(row.peak_gpu_mem_mib).toBe(2000);
    expect(row.avg_tokens_per_sec).toBe(30);
    expect(row.peak_tokens_per_sec).toBe(50);
    expect(calls.map((c) => c.metric).sort()).toEqual(
      [METRIC_IDS.gpuMemUsedMib, METRIC_IDS.inferTokensPerSec].sort(),
    );
  });
});

describe("运行历史：悬空 run 对账（面板重启）", () => {
  it("悬空 run 与当前运行容器同名 → 沿用不关闭", async () => {
    addModel({ name: "a" });
    await world.runtime.startModel("a"); // 面板重启前：a 在跑，run 已开

    // 模拟面板重启：新建一个 runtime 服务实例（内存状态清零），db/adapter 沿用（容器仍在跑）
    const restarted = createRuntimeService(world.db, world.adapter, world.root, world.root);
    await restarted.getRuntimeStatus();

    const row = runs()[0];
    expect(row.ended_at).toBeNull(); // 未被关闭，运行是连续的
    expect(row.end_reason).toBeNull();
  });

  it("悬空 run 与当前无运行容器 → 关闭并记 panel_restart", async () => {
    addModel({ name: "a" });
    await world.runtime.startModel("a");
    world.adapter.crash("llama-server"); // 面板停机期间容器也没了（未经面板 stop）

    const restarted = createRuntimeService(world.db, world.adapter, world.root, world.root);
    await restarted.getRuntimeStatus();

    const row = runs()[0];
    expect(row.ended_at).not.toBeNull();
    expect(row.end_reason).toBe("panel_restart");
  });

  it("对账只做一次：连续调两次 getRuntimeStatus()，第二次不产生新的对账动作", async () => {
    addModel({ name: "a" });
    await world.runtime.startModel("a");
    world.adapter.crash("llama-server");

    let aggregateCalls = 0;
    const deps: RuntimeDeps = {
      aggregate: () => {
        aggregateCalls += 1;
        return { max: 0, avg: 0, count: 0 };
      },
    };
    const restarted = createRuntimeService(world.db, world.adapter, world.root, world.root, deps);

    await restarted.getRuntimeStatus();
    const afterFirst = aggregateCalls;
    expect(afterFirst).toBeGreaterThan(0); // 第一次确实触发了一次 closeRun 聚合

    await restarted.getRuntimeStatus();
    expect(aggregateCalls).toBe(afterFirst); // 第二次没有再产生对账动作

    expect(runs()).toHaveLength(1); // 全程只有一条 run，未被重复处理出岔子
  });
});

// ---------- 并发互斥（真机实测缺陷）：第二个启停请求不能顶掉第一个仍在进行中的操作 ----------
//
// 真机时序：第二个 startModel 进来时 stopManagedBeforeStart 会把所有托管容器都停掉，
// 包括第一个请求刚创建、正在加载模型的那个（SIGKILL → exit 137），第一个请求的
// 启动轮询随后误报"容器启动即退出"。见 runtime.ts 中 exclusive() 的头注释。

describe("并发互斥：RuntimeBusyError", () => {
  /** 造一个 adapter.start 挂起在 gate 上的适配器，供测试手动控制"第一个操作何时完成" */
  function gatedStartAdapter(): { adapter: DockerAdapter; release: () => void } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter: DockerAdapter = {
      ...world.adapter,
      start: async (spec) => {
        await gate;
        return world.adapter.start(spec);
      },
    };
    return { adapter, release };
  }

  it("第一个 startModel 未完成时，第二个 startModel 直接抛 RuntimeBusyError；放行第一个后其正常完成", async () => {
    addModel({ name: "a" });
    addModel({ name: "b" });
    const { adapter, release } = gatedStartAdapter();
    const runtime = createRuntimeService(world.db, adapter, world.root, world.root);

    const firstPromise = runtime.startModel("a"); // 不 await：第一个仍在进行中
    await expect(runtime.startModel("b")).rejects.toBeInstanceOf(RuntimeBusyError);

    release();
    const first = await firstPromise;
    expect(first.id).toMatch(/^mock-/); // 第一个请求未被顶掉，正常完成
  });

  it("错误信息带上正在进行的动作与模型名", async () => {
    addModel({ name: "a" });
    addModel({ name: "b" });
    const { adapter, release } = gatedStartAdapter();
    const runtime = createRuntimeService(world.db, adapter, world.root, world.root);

    const firstPromise = runtime.startModel("a");
    let caught: unknown;
    try {
      await runtime.startModel("b");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RuntimeBusyError);
    const busy = caught as RuntimeBusyError;
    expect(busy.runningAction).toBe("start");
    expect(busy.runningModel).toBe("a");
    expect(busy.message).toContain("启动");
    expect(busy.message).toContain("a");

    release();
    await firstPromise;
  });

  it("操作失败后锁会释放：第一次 startModel 抛错，第二次仍能正常进行（漏写 finally 会把面板永久锁死）", async () => {
    addModel({ name: "a" });
    let calls = 0;
    const adapter: DockerAdapter = {
      ...world.adapter,
      start: async (spec) => {
        calls += 1;
        if (calls === 1) throw new Error("docker daemon 不可达");
        return world.adapter.start(spec);
      },
    };
    const runtime = createRuntimeService(world.db, adapter, world.root, world.root);

    await expect(runtime.startModel("a")).rejects.toThrow("docker daemon 不可达");
    await expect(runtime.startModel("a")).resolves.toMatchObject({ id: expect.any(String) });
  });

  it("getRuntimeStatus 在启动进行中仍可调用，不受互斥限制（启动弹窗/Chat 加载态靠它每 2s 轮询）", async () => {
    addModel({ name: "a" });
    const { adapter, release } = gatedStartAdapter();
    const runtime = createRuntimeService(world.db, adapter, world.root, world.root);

    const startPromise = runtime.startModel("a");
    await expect(runtime.getRuntimeStatus()).resolves.toEqual({ running: null }); // 容器尚未真正起来，查询本身不被拒绝/阻塞

    release();
    await startPromise;
  });

  it("restartModel 不会自锁：内部调用的是未包装的本地 startModel/stopByName，全程能跑通", async () => {
    addModel({ name: "a" });
    await world.runtime.startModel("a");

    await expect(world.runtime.restartModel("a")).resolves.toMatchObject({ id: expect.any(String) });
    const status = await world.runtime.getRuntimeStatus();
    expect(status.running?.model).toBe("a");
  });
});
