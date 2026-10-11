import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMockDockerAdapter } from "./adapters/mock";
import { openDb, runMigrations } from "./db";
import { chooseDefaultModel } from "./defaultModelChoice";
import { createModelRepo } from "./repo/models";
import { createUpstream, getDefaultUpstream, setDefaultUpstream, updateUpstream } from "./repo/upstreams";
import { createRuntimeService, type RuntimeService } from "./runtime";

let db: Database.Database;
let root: string;
let runtime: RuntimeService;

beforeEach(() => {
  db = openDb(":memory:");
  runMigrations(db);
  root = mkdtempSync(path.join(tmpdir(), "llamapad-defchoice-"));
  mkdirSync(path.join(root, "main"), { recursive: true });
  writeFileSync(path.join(root, "main/a.gguf"), "x");
  createModelRepo(db).createModel({
    name: "qwen",
    display_name: "qwen",
    namespace: "main",
    gguf_file: "main/a.gguf",
    overrides: {},
  });
  runtime = createRuntimeService(db, createMockDockerAdapter(), root, root);
  createUpstream(db, { name: "strata", displayName: "Strata", baseUrl: "http://up:8080" });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("chooseDefaultModel", () => {
  it("启用的外部上游：落库 default_upstream", async () => {
    expect(await chooseDefaultModel(db, runtime, "strata")).toEqual({ kind: "ok" });
    expect(getDefaultUpstream(db)).toBe("strata");
  });

  it("已停用的上游：upstream-disabled，且不改库", async () => {
    updateUpstream(db, "strata", { enabled: false });
    expect(await chooseDefaultModel(db, runtime, "strata")).toEqual({ kind: "upstream-disabled" });
    expect(getDefaultUpstream(db)).toBeNull();
  });

  it("运行中的托管模型：设为托管默认并清掉 default_upstream", async () => {
    await runtime.startModel("qwen");
    setDefaultUpstream(db, "strata");
    expect(await chooseDefaultModel(db, runtime, "qwen")).toEqual({ kind: "ok" });
    expect(getDefaultUpstream(db)).toBeNull();
  });

  it("托管模型没在跑：not-running 带原文案，且不清 default_upstream", async () => {
    setDefaultUpstream(db, "strata");
    const result = await chooseDefaultModel(db, runtime, "qwen");
    expect(result.kind).toBe("not-running");
    expect(result.kind === "not-running" && result.message.length > 0).toBe(true);
    expect(getDefaultUpstream(db)).toBe("strata");
  });
});
