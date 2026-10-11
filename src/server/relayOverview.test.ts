import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMockDockerAdapter } from "./adapters/mock";
import { openDb, runMigrations } from "./db";
import { llamaUpstreamBase } from "./llamaProxy";
import { buildRelayOverview } from "./relayOverview";
import { createModelRepo, type ModelRepo } from "./repo/models";
import { buildContainerSpec, createRuntimeService, type RuntimeService } from "./runtime";

let db: Database.Database;
let repo: ModelRepo;
let adapter: ReturnType<typeof createMockDockerAdapter>;
let runtime: RuntimeService;
let root: string;

beforeEach(() => {
  db = openDb(":memory:");
  runMigrations(db);
  root = mkdtempSync(path.join(tmpdir(), "relay-overview-"));
  repo = createModelRepo(db);
  adapter = createMockDockerAdapter();
  runtime = createRuntimeService(db, adapter, root, root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function run(name: string): Promise<void> {
  await adapter.start(buildContainerSpec(repo.getModel(name)!, repo.getDefaultConfig(), root));
}

const ready = async () => true;

describe("buildRelayOverview", () => {
  it("没有模型在跑 → 空列表、默认为 null", async () => {
    expect(await buildRelayOverview(db, runtime, ready)).toEqual({ defaultModel: null, services: [] });
  });

  it("运行中的模型带连接信息与合并后的关键参数", async () => {
    repo.createModel({
      name: "qwen",
      display_name: "Qwen",
      namespace: "main",
      gguf_file: "main/a.gguf",
      overrides: { server: { ctx_size: 8192 } },
    });
    await run("qwen");

    const overview = await buildRelayOverview(db, runtime, ready);
    const defaults = repo.getDefaultConfig();

    expect(overview.defaultModel).toBe("qwen");
    expect(overview.services).toHaveLength(1);
    const service = overview.services[0];
    expect(service.model).toBe("qwen");
    expect(service.displayName).toBe("Qwen");
    expect(service.isDefault).toBe(true);
    expect(service.ready).toBe(true);
    expect(service.hostPort).toBe(defaults.docker.host_port);
    expect(service.upstreamBase).toBe(llamaUpstreamBase(defaults.docker.host_port));
    expect(service.params).toEqual({
      image: defaults.docker.image,
      gpu: defaults.docker.gpu,
      ctxSize: 8192,
      gpuLayers: defaults.server.gpu_layers,
      reasoningEffort: defaults.server.reasoning_effort,
      effortRounding: defaults.api.effort_rounding,
      effortAliasCount: 0,
      specType: defaults.server.spec_type,
    });
  });

  it("模型行已删 → params 为 null，其余字段仍在", async () => {
    repo.createModel({ name: "gone", display_name: "Gone", namespace: "main", gguf_file: "main/a.gguf", overrides: {} });
    await run("gone");
    repo.deleteModel("gone");

    const [service] = (await buildRelayOverview(db, runtime, ready)).services;
    expect(service.model).toBe("gone");
    expect(service.params).toBeNull();
  });
});
