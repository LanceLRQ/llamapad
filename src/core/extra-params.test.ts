import { describe, expect, it } from "vitest";
import { EXTRA_PARAMS, LLAMA_OPTIONS_SOURCE, buildExtraArgs, draftToExtra, extraParamsSchema,
  extraToDraft, rawExtraConflicts, searchExtraParams } from "./extra-params";
import { buildArgs } from "./args";
import { BUILTIN_DEFAULT_CONFIG, mergeConfig } from "./config";

describe("llama-server Extra 参数", () => {
  it("完整记录官方参数，每项都有中英文说明且没有重复别名", () => {
    expect(LLAMA_OPTIONS_SOURCE.signatures).toHaveLength(260);
    expect(LLAMA_OPTIONS_SOURCE.options.length + LLAMA_OPTIONS_SOURCE.excluded.length).toBe(260);
    expect([...EXTRA_PARAMS.map((p) => p.signature), ...LLAMA_OPTIONS_SOURCE.excluded.map((p) => p.signature)].sort())
      .toEqual([...LLAMA_OPTIONS_SOURCE.signatures].sort());
    expect(EXTRA_PARAMS.length).toBeGreaterThan(190);
    const flags = EXTRA_PARAMS.flatMap((p) => p.aliases);
    expect(new Set(flags).size).toBe(flags.length);
    for (const p of EXTRA_PARAMS) {
      expect(p.description.zh.length).toBeGreaterThan(8);
      expect(p.description.en.length).toBeGreaterThan(8);
    }
  });

  it("搜索同时支持名称、CLI 别名、中英文用法说明，常用项排前", () => {
    expect(EXTRA_PARAMS[0].key).toBe("parallel");
    for (const query of ["并发", "-np", "--parallel", "number of server slots"]) {
      expect(searchExtraParams(query).map((p) => p.key)).toContain("parallel");
    }
    expect(searchExtraParams(" MiB ").map((p) => p.key)).toContain("cache_ram");
    expect(searchExtraParams("not a real parameter 12345")).toEqual([]);
    expect(searchExtraParams("", true, { seed: "0", kv_unified: "false" }, { parallel: 4 }).map((p) => p.key))
      .toEqual(["parallel", "kv_unified", "seed"]);
  });

  it("每种表单值往返一致，非法数字和 JSON 不会被静默丢弃", () => {
    const input = { seed: 0, kv_unified: false, reverse_prompt: ["END with spaces", " STOP"],
      control_vector_layer_range: ["1", "4"], chat_template_kwargs: '{"custom":true}' };
    expect(draftToExtra(extraToDraft(input))).toEqual(input);
    expect(draftToExtra({ parallel: "", seed: "0" })).toEqual({ seed: 0 });
    expect(extraParamsSchema.safeParse(draftToExtra({ parallel: "abc" })).success).toBe(false);
    expect(extraParamsSchema.safeParse(draftToExtra({ seed: " " })).success).toBe(false);
    expect(extraParamsSchema.safeParse({ chat_template_kwargs: '{"enable_thinking":true}' }).success).toBe(false);
  });

  it("原始参数覆盖检查识别别名和等号形式，不把参数值当成标志", () => {
    expect(rawExtraConflicts({ parallel: 4, seed: 0 }, ["-np", "8", "--seed=42"]))
      .toEqual(["--parallel", "--seed"]);
    expect(rawExtraConflicts({ parallel: 4 }, ["--reverse-prompt", "--parallel"]))
      .toEqual([]);
    expect(rawExtraConflicts({ parallel: 4 }, ["--grammar", "--parallel"]))
      .toEqual([]);
  });

  it("没有填写的 Extra 不产生参数，0 和 false 不丢失", () => {
    expect(buildExtraArgs({})).toEqual([]);
    expect(buildExtraArgs({ seed: 0, kv_unified: false, warmup: false })).toEqual([
      "--no-kv-unified", "--no-warmup", "--seed", "0",
    ]);
  });

  it("休眠时间只接受 -1 或正整数，拒绝会使上游启动失败的 0", () => {
    for (const value of [-2, 0, 1.5]) {
      expect(extraParamsSchema.safeParse({ sleep_idle_seconds: value }).success).toBe(false);
    }
    for (const value of [-1, 1, 60]) {
      expect(buildExtraArgs({ sleep_idle_seconds: value })).toEqual(["--sleep-idle-seconds", String(value)]);
    }
  });

  it.each(["image_min_tokens", "image_max_tokens"])("%s 支持用 -1 覆盖全局限制并恢复模型默认值", (key) => {
    for (const value of [-2, 0, 1.5]) {
      expect(extraParamsSchema.safeParse({ [key]: value }).success).toBe(false);
    }
    const defaults = { ...BUILTIN_DEFAULT_CONFIG, server: { ...BUILTIN_DEFAULT_CONFIG.server,
      extra: { [key]: 512 } } };
    for (const value of [-1, 1, 256]) {
      const merged = mergeConfig(defaults, { server: { extra: { [key]: value } } });
      expect(buildExtraArgs(merged.server.extra ?? {})).toEqual([`--${key.replaceAll("_", "-")}`, String(value)]);
    }
  });

  it("校验未知键、数字、JSON、多值及重复项，不允许把字符串当参数注入", () => {
    for (const input of [{ nope: 1 }, { parallel: 0 }, { parallel: "4" }, { parallel: 1.5 },
      { json_schema: "{" }, { control_vector_layer_range: ["1"] }]) {
      expect(extraParamsSchema.safeParse(input).success).toBe(false);
    }
    expect(buildExtraArgs({ reverse_prompt: ["END", "--parallel 99"], control_vector_layer_range: ["1", "4"] }))
      .toEqual(["--control-vector-layer-range", "1", "4", "--reverse-prompt", "END", "--reverse-prompt", "--parallel 99"]);
  });

  it("全局 Extra 逐键继承，模型覆盖不会抹掉其他全局键", () => {
    const defaults = { ...BUILTIN_DEFAULT_CONFIG, server: { ...BUILTIN_DEFAULT_CONFIG.server,
      extra: { parallel: 4, kv_unified: true } } };
    const merged = mergeConfig(defaults, { server: { extra: { seed: 0, kv_unified: false } } });
    expect(merged.server.extra).toEqual({ parallel: 4, seed: 0, kv_unified: false });
    expect(buildArgs({ server: merged.server, modelPath: "/models/test.gguf", port: 8080 }))
      .toEqual(expect.arrayContaining(["--parallel", "4", "--seed", "0", "--no-kv-unified"]));
  });

  it("模板扩展变量与面板变量合并，只下发一个 kwargs 参数", () => {
    const args = buildArgs({ server: { ...BUILTIN_DEFAULT_CONFIG.server,
      extra: { chat_template_kwargs: '{"custom":true}' } }, modelPath: "/models/test.gguf", port: 8080 });
    expect(args.filter((a) => a === "--chat-template-kwargs")).toHaveLength(1);
    expect(JSON.parse(args[args.indexOf("--chat-template-kwargs") + 1])).toEqual({ enable_thinking: false, custom: true });
  });

  it("合并后的重复参数数组不与全局配置共享引用", () => {
    const defaults = { ...BUILTIN_DEFAULT_CONFIG, server: { ...BUILTIN_DEFAULT_CONFIG.server,
      extra: { reverse_prompt: ["END"] } } };
    const merged = mergeConfig(defaults, {});
    const prompts = merged.server.extra?.reverse_prompt;
    if (!Array.isArray(prompts)) throw new Error("Missing reverse_prompt");
    prompts.push("STOP");
    expect(defaults.server.extra.reverse_prompt).toEqual(["END"]);
  });
});
