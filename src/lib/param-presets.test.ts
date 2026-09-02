import { describe, expect, it } from "vitest";
import { PARAM_PRESET_IDS, applyPresetDraft, presetDraftPatch } from "./param-presets";

describe("presetDraftPatch", () => {
  it("保守：gpu_layers=0（纯 CPU 冒烟），不写 KV（不写 = 不动，不是清空）", () => {
    const patch = presetDraftPatch("conservative");
    expect(patch).toEqual({ gpuLayers: "0" });
    expect("cacheK" in patch).toBe(false);
    expect("cacheV" in patch).toBe(false);
  });

  it("平衡：gpu_layers=999（全卸载），KV=q8_0", () => {
    expect(presetDraftPatch("balanced")).toEqual({
      gpuLayers: "999",
      cacheK: "q8_0",
      cacheV: "q8_0",
    });
  });

  it("全卸载：gpu_layers=999（KV 跟随默认），不写 KV（不写 = 不动，不是清空）", () => {
    const patch = presetDraftPatch("full");
    expect(patch).toEqual({ gpuLayers: "999" });
    expect("cacheK" in patch).toBe(false);
    expect("cacheV" in patch).toBe(false);
  });

  it("保守档不再清空 KV 量化 —— 不写的键保持原样，不悄悄抹掉用户手调的值", () => {
    const patch = presetDraftPatch("conservative");
    expect(patch).toEqual({ gpuLayers: "0" });
    expect("cacheK" in patch).toBe(false);
  });

  it("三个 id 都只触碰 gpuLayers/cacheK/cacheV 三键（只减不增）", () => {
    for (const id of PARAM_PRESET_IDS) {
      const keys = Object.keys(presetDraftPatch(id)).sort();
      expect(keys).toContain("gpuLayers");
      expect(keys.every((k) => ["cacheK", "cacheV", "gpuLayers"].includes(k))).toBe(true);
    }
  });
});

describe("applyPresetDraft", () => {
  const drafts = {
    gpuLayers: "42",
    ctxSize: "8192",
    cacheK: "q4_0",
    cacheV: "",
    temp: "0.6",
  };

  it("只覆盖预设三键，其余草稿原样保留", () => {
    const next = applyPresetDraft(drafts, "balanced");
    expect(next).toEqual({
      gpuLayers: "999",
      ctxSize: "8192",
      cacheK: "q8_0",
      cacheV: "q8_0",
      temp: "0.6",
    });
  });

  it("返回新对象，不修改入参", () => {
    const before = { ...drafts };
    applyPresetDraft(drafts, "conservative");
    expect(drafts).toEqual(before);
  });

  it("预设可互相切换（写过的键覆盖，未写的保留原值）", () => {
    const a = applyPresetDraft(drafts, "balanced");
    const b = applyPresetDraft(a, "full");
    expect(b).toEqual({
      gpuLayers: "999",
      ctxSize: "8192",
      cacheK: "q8_0",
      cacheV: "q8_0",
      temp: "0.6",
    });
  });
});
