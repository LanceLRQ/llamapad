import { describe, expect, it } from "vitest";

import { draftToPresetServer, presetServerToDraftPatch } from "./preset-draft";
import type { DraftState } from "./model-form";

const emptyDraft = (over: Partial<DraftState> = {}): DraftState => ({
  displayName: "", namespace: "main", ggufFile: "", mmproj: "",
  containerName: "", hostPort: "", image: "",
  gpuMode: "default", gpuDevices: "",
  gpuLayers: "", ctxSize: "", cacheK: "", cacheV: "", flashAttn: "",
  thinking: "", effort: "", temp: "", topP: "", topK: "", minP: "",
  repeatPenalty: "", presencePenalty: "",
  ...over,
});

describe("presetServerToDraftPatch", () => {
  it("数字字段转成字符串草稿", () => {
    expect(presetServerToDraftPatch({ temp: 0.6, top_k: 20, ctx_size: 8192 })).toEqual({
      temp: "0.6",
      topK: "20",
      ctxSize: "8192",
    });
  });

  it("枚举字段原样落草稿", () => {
    expect(presetServerToDraftPatch({ cache_type_k: "q8_0", flash_attention: "on" })).toEqual({
      cacheK: "q8_0",
      flashAttn: "on",
    });
  });

  it("布尔字段转字符串（草稿全是字符串）", () => {
    expect(presetServerToDraftPatch({ enable_thinking: false })).toEqual({ thinking: "false" });
  });

  it("预设里没有的字段不出现在补丁里（不写 = 不动那一项，而不是清空）", () => {
    const patch = presetServerToDraftPatch({ temp: 1 });
    expect(patch).toEqual({ temp: "1" });
    expect("topP" in patch).toBe(false);
  });

  it("空预设产出空补丁", () => {
    expect(presetServerToDraftPatch({})).toEqual({});
  });
});

describe("draftToPresetServer", () => {
  it("非空草稿字段转回预设值", () => {
    const server = draftToPresetServer(
      emptyDraft({ temp: "0.6", topK: "20", cacheK: "q8_0", thinking: "false" }),
    );
    expect(server).toEqual({ temp: 0.6, top_k: 20, cache_type_k: "q8_0", enable_thinking: false });
  });

  it("空串字段一律不进预设（空串 = 未覆盖，不是 0）", () => {
    expect(draftToPresetServer(emptyDraft({ temp: "", gpuLayers: "" }))).toEqual({});
  });

  it("gpu_layers=0 要保留 —— 0 是「纯 CPU」这个真实诉求，不是空值", () => {
    expect(draftToPresetServer(emptyDraft({ gpuLayers: "0" }))).toEqual({ gpu_layers: 0 });
  });

  it("非法数字丢弃而不是产出 NaN", () => {
    expect(draftToPresetServer(emptyDraft({ temp: "abc" }))).toEqual({});
  });

  it("docker 段字段不参与（预设一期只存 server 段）", () => {
    expect(draftToPresetServer(emptyDraft({ hostPort: "18080", image: "x" }))).toEqual({});
  });

  it("与 presetServerToDraftPatch 互为逆（往返不失真）", () => {
    const server = { temp: 0.6, top_p: 0.95, top_k: 20, gpu_layers: 999, cache_type_k: "q8_0" } as const;
    const patch = presetServerToDraftPatch(server);
    expect(draftToPresetServer(emptyDraft(patch))).toEqual(server);
  });
});
