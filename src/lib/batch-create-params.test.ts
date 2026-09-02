import { describe, expect, it } from "vitest";

import {
  DEFAULT_PARAM_PICK,
  initialParamSelection,
  paramServerForPick,
  parseParamPick,
  presetPickValue,
  profilePickValue,
  summarizeParamServer,
} from "./batch-create-params";
import type { RecommendedProfile } from "./readme-params";
import type { ServerConfig } from "@/core/schemas";
import type { ParamPreset } from "@/server/repo/presets";

const effective = { temp: 0.8, top_p: 0.9, presence_penalty: 0 } as ServerConfig;

function makeProfile(overrides: Partial<RecommendedProfile> = {}): RecommendedProfile {
  return {
    id: "kv-list-abc123",
    label: "Thinking Mode",
    source: "kv-list",
    server: { temp: 0.6, top_p: 0.95, presence_penalty: 1.5, ctx_size: 204800 },
    extras: [],
    excerpt: "",
    confidence: "high",
    ...overrides,
  };
}

function makePreset(overrides: Partial<ParamPreset> = {}): ParamPreset {
  return {
    id: 7,
    name: "我的预设",
    description: null,
    server: { temp: 0.4, top_k: 20 },
    source: "manual",
    sourceRepo: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("parseParamPick", () => {
  it("profile: 前缀解出 id", () => {
    expect(parseParamPick("profile:kv-list-abc123")).toEqual({ kind: "profile", id: "kv-list-abc123" });
  });

  it("preset: 前缀解出数字 id", () => {
    expect(parseParamPick("preset:7")).toEqual({ kind: "preset", id: 7 });
  });

  it("preset: 后面不是合法数字时归到 default", () => {
    expect(parseParamPick("preset:abc")).toEqual({ kind: "default" });
  });

  it("其余任何值（含 DEFAULT_PARAM_PICK 本身）归到 default", () => {
    expect(parseParamPick(DEFAULT_PARAM_PICK)).toEqual({ kind: "default" });
    expect(parseParamPick("garbage")).toEqual({ kind: "default" });
  });

  it("profilePickValue / presetPickValue 与 parseParamPick 互为逆运算", () => {
    expect(parseParamPick(profilePickValue("x-1"))).toEqual({ kind: "profile", id: "x-1" });
    expect(parseParamPick(presetPickValue(42))).toEqual({ kind: "preset", id: 42 });
  });
});

describe("paramServerForPick", () => {
  it("default → 空对象", () => {
    expect(paramServerForPick(DEFAULT_PARAM_PICK, [], [], effective)).toEqual({});
  });

  it("选中 profile 时只取采样类字段（ctx_size 是性能类，不进结果）", () => {
    const profile = makeProfile();
    const server = paramServerForPick(profilePickValue(profile.id), [profile], [], effective);
    expect(server).toEqual({ temp: 0.6, top_p: 0.95, presence_penalty: 1.5 });
  });

  it("profile id 在列表里找不到时返回空对象，不抛错", () => {
    expect(paramServerForPick(profilePickValue("missing"), [], [], effective)).toEqual({});
  });

  it("选中 preset 时原样使用 preset.server，不做采样/性能过滤", () => {
    const preset = makePreset({ server: { temp: 0.4, ctx_size: 8192 } });
    const server = paramServerForPick(presetPickValue(preset.id), [], [preset], effective);
    expect(server).toEqual({ temp: 0.4, ctx_size: 8192 });
  });

  it("preset id 在列表里找不到时返回空对象", () => {
    expect(paramServerForPick(presetPickValue(999), [], [], effective)).toEqual({});
  });
});

describe("initialParamSelection", () => {
  it("initialServer 非空时原样使用，即使它是 profile 采样字段的子集（用户已手动去掉一项）", () => {
    const profile = makeProfile();
    const result = initialParamSelection([profile], effective, profile.id, { temp: 0.6, top_p: 0.95 });
    expect(result).toEqual({
      pick: profilePickValue(profile.id),
      server: { temp: 0.6, top_p: 0.95 },
    });
  });

  it("initialServer 缺失、initialProfileId 能在 profiles 里找到时退化成「从下拉现选」（只取采样类）", () => {
    const profile = makeProfile();
    const result = initialParamSelection([profile], effective, profile.id, undefined);
    expect(result).toEqual({
      pick: profilePickValue(profile.id),
      server: { temp: 0.6, top_p: 0.95, presence_penalty: 1.5 },
    });
  });

  it("initialServer 缺失、initialProfileId 在 profiles 里找不到（硬刷新直接落在文件视图）时落回走全局默认", () => {
    const result = initialParamSelection([], effective, "kv-list-abc123", undefined);
    expect(result).toEqual({ pick: DEFAULT_PARAM_PICK, server: {} });
  });

  it("两者都缺失时走全局默认", () => {
    expect(initialParamSelection([], effective, undefined, undefined)).toEqual({
      pick: DEFAULT_PARAM_PICK,
      server: {},
    });
  });

  it("initialServer 为空对象时等同于缺失", () => {
    const result = initialParamSelection([], effective, undefined, {});
    expect(result).toEqual({ pick: DEFAULT_PARAM_PICK, server: {} });
  });
});

describe("summarizeParamServer", () => {
  it("空对象返回 null", () => {
    expect(summarizeParamServer({})).toBeNull();
  });

  it("1 个字段不带 +N", () => {
    expect(summarizeParamServer({ temp: 0.6 })).toBe("temp 0.6");
  });

  it("恰好 2 个字段不带 +N", () => {
    expect(summarizeParamServer({ temp: 0.6, top_p: 0.95 })).toBe("temp 0.6 · top_p 0.95");
  });

  it("超过 2 个字段时前 2 个内联、其余折成 +N", () => {
    expect(summarizeParamServer({ temp: 0.6, top_p: 0.95, top_k: 20, min_p: 0.05 })).toBe(
      "temp 0.6 · top_p 0.95 · +2",
    );
  });

  it("非数字值按 String() 格式化（布尔/字符串字段）", () => {
    expect(summarizeParamServer({ enable_thinking: true })).toBe("enable_thinking true");
  });
});
