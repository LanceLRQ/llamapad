import { describe, expect, it } from "vitest";
import { PARAM_PRESET_IDS, applyPresetDraft, presetDraftPatch } from "./param-presets";

describe("presetDraftPatch", () => {
  it("保守：gpu_layers=0（纯 CPU 冒烟），KV 清覆盖（跟随默认）", () => {
    expect(presetDraftPatch("conservative")).toEqual({ gpuLayers: "0", cacheK: "", cacheV: "" });
  });

  it("平衡：gpu_layers=999（全卸载），KV=q8_0", () => {
    expect(presetDraftPatch("balanced")).toEqual({
      gpuLayers: "999",
      cacheK: "q8_0",
      cacheV: "q8_0",
    });
  });

  it("全卸载：gpu_layers=999，KV 清覆盖（f16 默认）", () => {
    expect(presetDraftPatch("full")).toEqual({ gpuLayers: "999", cacheK: "", cacheV: "" });
  });

  it("三个 id 都只触碰 gpuLayers/cacheK/cacheV 三键", () => {
    for (const id of PARAM_PRESET_IDS) {
      expect(Object.keys(presetDraftPatch(id)).sort()).toEqual(["cacheK", "cacheV", "gpuLayers"]);
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

  it("预设可互相切换（覆盖而非叠加）", () => {
    const a = applyPresetDraft(drafts, "balanced");
    const b = applyPresetDraft(a, "full");
    expect(b).toEqual({
      gpuLayers: "999",
      ctxSize: "8192",
      cacheK: "",
      cacheV: "",
      temp: "0.6",
    });
  });
});
