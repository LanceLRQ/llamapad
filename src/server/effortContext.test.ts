import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGguf } from "../core/gguf.testkit";
import { getEffortMappingContext } from "./effortContext";
import { openDb, runMigrations } from "./db";
import { createModelRepo } from "./repo/models";

/**
 * getEffortMappingContext 测试（真实文件系统 + 内存 sqlite，对齐 ggufMeta.test.ts 惯例）：
 * 只测"上下文组装对不对"（api 段字段改名、gguf 定位、降级到 unknown 的三个分支），
 * detectReasoningEffort 本身的值域提取规则已在 reasoning-effort.test.ts 覆盖，不重复。
 */

const CHAT_TEMPLATE =
  "{%- if reasoning_effort not in ('xhigh', 'medium', 'low') %}{{- raise_exception('nope') }}{%- endif %}";

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "llamapad-effortctx-"));
  db = openDb(":memory:");
  runMigrations(db);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("getEffortMappingContext", () => {
  it("正常场景：从模型 overrides 拿到 api 段（字段改名 effort_aliases→aliases），从 gguf 探出支持态", () => {
    const abs = path.join(dir, "model.gguf");
    writeFileSync(abs, buildGguf([["tokenizer.chat_template", { t: 8, v: CHAT_TEMPLATE }]]));

    const repo = createModelRepo(db);
    repo.createModel({
      name: "qwen",
      display_name: "Qwen",
      namespace: "main",
      gguf_file: "model.gguf",
      overrides: { api: { effort_aliases: { max: "xhigh" }, effort_rounding: "up" } },
    });

    return getEffortMappingContext(db, dir, "qwen").then((ctx) => {
      expect(ctx.config).toEqual({ aliases: { max: "xhigh" }, rounding: "up" });
      expect(ctx.support).toEqual({ state: "supported", levels: ["xhigh", "medium", "low"] });
    });
  });

  it("模型未配 api overrides：沿用全局默认配置", async () => {
    const abs = path.join(dir, "model.gguf");
    writeFileSync(abs, buildGguf([["tokenizer.chat_template", { t: 8, v: CHAT_TEMPLATE }]]));

    const repo = createModelRepo(db);
    repo.createModel({
      name: "qwen",
      display_name: "Qwen",
      namespace: "main",
      gguf_file: "model.gguf",
      overrides: {},
    });

    const ctx = await getEffortMappingContext(db, dir, "qwen");
    expect(ctx.config).toEqual({ aliases: {}, rounding: "down" });
  });

  it("模型不存在 → support 降级为 unknown，config 取全局默认（不是拒绝改写）", async () => {
    const ctx = await getEffortMappingContext(db, dir, "does-not-exist");
    expect(ctx.support).toEqual({ state: "unknown", levels: null });
    expect(ctx.config).toEqual({ aliases: {}, rounding: "down" });
  });

  it("gguf 文件缺失 → support 降级为 unknown", async () => {
    const repo = createModelRepo(db);
    repo.createModel({
      name: "ghost",
      display_name: "Ghost",
      namespace: "main",
      gguf_file: "missing.gguf",
      overrides: {},
    });

    const ctx = await getEffortMappingContext(db, dir, "ghost");
    expect(ctx.support).toEqual({ state: "unknown", levels: null });
  });
});
