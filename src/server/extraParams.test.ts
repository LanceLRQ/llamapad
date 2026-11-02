import { describe, expect, it } from "vitest";
import { BUILTIN_DEFAULT_CONFIG, effectiveParams, mergeConfig } from "@/core/config";
import { EXTRA_PARAMS, type ExtraParams } from "@/core/extra-params";
import type { ModelConfig } from "@/core/schemas";
import { fromExportYaml, toExportYaml } from "@/core/yamlIo";
import { deriveOverrides, initDrafts, initDuplicateDrafts, mergeForSave } from "@/lib/model-form";
import { draftToPresetServer, presetServerToDraftPatch } from "@/lib/preset-draft";
import { openDb, runMigrations } from "./db";
import { createModelRepo } from "./repo/models";
import { buildContainerSpec } from "./runtime";

const extra: ExtraParams = { parallel: 4, kv_unified: false, seed: 0, reverse_prompt: ["END with spaces", " STOP"] };
const model: ModelConfig = { name: "extra-test", display_name: "Extra", namespace: "main", gguf_file: "main/test.gguf", overrides: { server: { extra }, docker: { extra_args: ["-np", "8"] } } };

describe("Extra 配置端到端往返", () => {
  it("编辑、清空、克隆、预设保留三态和重复参数", () => {
    const drafts = initDrafts(model);
    expect(deriveOverrides(drafts).server?.extra).toEqual(extra);
    expect(deriveOverrides(initDuplicateDrafts(model, " copy")).server?.extra).toEqual(extra);
    expect(draftToPresetServer(drafts).extra).toEqual(extra);
    expect(presetServerToDraftPatch({ extra: { parallel: 8 } }, drafts.extra).extra)
      .toEqual({ parallel: "8", kv_unified: "false", seed: "0", reverse_prompt: "END with spaces\n STOP" });
    const cleared = mergeForSave(model.overrides, deriveOverrides({ ...drafts, extra: {} }));
    expect(cleared.server?.extra).toBeUndefined();
    expect(cleared.docker?.extra_args).toEqual(["-np", "8"]);
    expect(mergeConfig({ ...BUILTIN_DEFAULT_CONFIG, server: { ...BUILTIN_DEFAULT_CONFIG.server, extra: { parallel: 2 } } }, cleared).server.extra)
      .toEqual({ parallel: 2 });
  });

  it("YAML 在默认配置、模型和预设中均能往返保存", () => {
    const bundle = { defaults: { ...BUILTIN_DEFAULT_CONFIG, server: { ...BUILTIN_DEFAULT_CONFIG.server, extra: { threads: 4 } } },
      models: [model], namespaces: ["main"], presets: [{ name: "concurrent", server: { extra } }] };
    expect(fromExportYaml(toExportYaml(bundle))).toEqual(bundle);
  });

  it("SQLite 的现有 JSON 列无需迁移即可保存并校验 Extra", () => {
    const db = openDb(":memory:");
    try {
      runMigrations(db);
      const columns = db.prepare("PRAGMA table_info(models)").all() as { name: string; type: string }[];
      expect(columns.find((c) => c.name === "overrides")?.type).toBe("TEXT");
      const repo = createModelRepo(db);
      repo.createModel(model);
      expect(repo.getModel(model.name)?.overrides.server?.extra).toEqual(extra);
      repo.setDefaultConfig({ ...BUILTIN_DEFAULT_CONFIG, server: { ...BUILTIN_DEFAULT_CONFIG.server, extra } });
      expect(repo.getDefaultConfig().server.extra).toEqual(extra);
      expect(() => repo.updateModel(model.name, { overrides: { server: { extra: { parallel: 0 } } } })).toThrow(/parallel/);
    } finally { db.close(); }
  });

  it("原始附加参数最后追加，完整 args_override 整体替换", () => {
    const spec = buildContainerSpec(model, BUILTIN_DEFAULT_CONFIG, "/host/models");
    expect(spec.args.slice(-2)).toEqual(["-np", "8"]);
    expect(spec.args).toContain("--no-kv-unified");
    expect(spec.args).toContain("END with spaces");
    const replaced = buildContainerSpec({ ...model, overrides: { ...model.overrides,
      docker: { args_override: ["--model", "{{model_path}}", "--parallel", "2"] } } }, BUILTIN_DEFAULT_CONFIG, "/host/models");
    expect(replaced.args).toEqual(["--model", "/models/main/test.gguf", "--parallel", "2"]);
    expect(effectiveParams(BUILTIN_DEFAULT_CONFIG, model.overrides)["server.extra.seed"]).toBe(0);
  });

  it("所有已收录参数都能校验并生成正确的 argv 形态", () => {
    for (const p of EXTRA_PARAMS) {
      const value = p.kind === "boolean" ? true : p.kind === "layers" ? "all" : p.kind === "number" ? p.nonzero ? 1 : p.min ?? 1
        : p.kind === "enum" ? p.choices![0] : p.kind === "json" ? "{}"
          : p.kind === "range" ? ["1", "2"] : p.kind === "repeat" ? ["entry with spaces"] : "entry with spaces";
      const args = buildContainerSpec({ ...model, overrides: { server: { extra: { [p.key]: value } } } }, BUILTIN_DEFAULT_CONFIG, "/host/models").args;
      expect(args, p.key).toContain(p.flag);
    }
  });
});
