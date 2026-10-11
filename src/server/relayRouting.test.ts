import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { INITIAL_HEALTH, type UpstreamHealth } from "../lib/upstream-health";
import { openDb, runMigrations } from "./db";
import { effectiveDefault, loadRelayContext, routeInputOf } from "./relayRouting";
import { createModelRepo } from "./repo/models";
import { createUpstream, setDefaultUpstream, updateUpstream } from "./repo/upstreams";
import type { RuntimeService, RuntimeStatus } from "./runtime";

let db: Database.Database;
let status: RuntimeStatus;
let health: Record<string, UpstreamHealth>;

const runtime = { getRuntimeStatus: async () => status } as unknown as RuntimeService;
const monitor = { snapshot: (name: string) => health[name] ?? INITIAL_HEALTH };

function running(model: string) {
  return { model, container: `c-${model}`, startedAt: "2026-10-11T00:00:00.000Z", hostPort: 18080 };
}

beforeEach(() => {
  db = openDb(":memory:");
  runMigrations(db);
  status = { running: null, models: [], defaultModel: null, starting: [] };
  health = {};
  createUpstream(db, { name: "strata", displayName: "Strata", baseUrl: "http://up:8080" });
});

describe("loadRelayContext + routeInputOf", () => {
  it("把运行状态、上游与存活状态合成路由输入", async () => {
    createModelRepo(db).createModel({
      name: "qwen",
      display_name: "Qwen",
      namespace: "main",
      gguf_file: "main/a.gguf",
      overrides: {},
    });
    status = { running: running("qwen"), models: [running("qwen")], defaultModel: "qwen", starting: [] };
    setDefaultUpstream(db, "strata");
    health.strata = { ...INITIAL_HEALTH, state: "unreachable", failures: 3 };

    const ctx = await loadRelayContext(db, runtime, monitor);
    const input = routeInputOf(ctx, db, "gpt-4o");

    expect(input.requested).toBe("gpt-4o");
    expect(input.running).toEqual(["qwen"]);
    expect(input.managedDefault).toBe("qwen");
    expect(input.defaultUpstream).toBe("strata");
    expect(input.upstreams).toEqual([
      { name: "strata", enabled: true, routable: false, upstreamModel: null, aliases: [] },
    ]);
    expect(input.isConfiguredModel("qwen")).toBe(true);
    expect(input.isConfiguredModel("gpt-4o")).toBe(false);
  });
});

describe("别名装配", () => {
  it("把库里的上游模型名与别名（按存储顺序）带进路由输入", async () => {
    updateUpstream(db, "strata", {
      upstreamModel: "base",
      aliases: [{ alias: "gpt-4.1", upstreamModel: "t" }, { alias: "Qwen-Flash" }],
    });
    const input = routeInputOf(await loadRelayContext(db, runtime, monitor), db, "gpt-4.1");
    expect(input.upstreams).toEqual([
      {
        name: "strata",
        enabled: true,
        routable: true,
        upstreamModel: "base",
        aliases: [
          { alias: "gpt-4.1", upstreamModel: "t" },
          { alias: "Qwen-Flash", upstreamModel: null },
        ],
      },
    ]);
  });
});

describe("effectiveDefault", () => {
  it("没有任何目标", async () => {
    expect(effectiveDefault(await loadRelayContext(db, runtime, monitor))).toEqual({
      name: null,
      kind: null,
      degraded: false,
    });
  });

  it("默认上游生效", async () => {
    setDefaultUpstream(db, "strata");
    expect(effectiveDefault(await loadRelayContext(db, runtime, monitor))).toEqual({
      name: "strata",
      kind: "external",
      degraded: false,
    });
  });

  it("默认上游不可达且有托管模型 → 降级", async () => {
    setDefaultUpstream(db, "strata");
    health.strata = { ...INITIAL_HEALTH, state: "unreachable", failures: 3 };
    status = { running: running("qwen"), models: [running("qwen")], defaultModel: "qwen", starting: [] };
    expect(effectiveDefault(await loadRelayContext(db, runtime, monitor))).toEqual({
      name: "qwen",
      kind: "managed",
      degraded: true,
    });
  });

  it("默认上游被停用 → 回到托管默认，不算降级", async () => {
    setDefaultUpstream(db, "strata");
    updateUpstream(db, "strata", { enabled: false });
    status = { running: running("qwen"), models: [running("qwen")], defaultModel: "qwen", starting: [] };
    expect(effectiveDefault(await loadRelayContext(db, runtime, monitor))).toEqual({
      name: "qwen",
      kind: "managed",
      degraded: false,
    });
  });
});
