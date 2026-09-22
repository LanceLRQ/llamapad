import { describe, expect, it } from "vitest";
import { decideModelRoute, extractRequestedModel, requestedModelFromQuery } from "./model-route";

describe("extractRequestedModel：从 JSON 请求体取 model", () => {
  it("字符串字段 → 去首尾空白后返回", () => {
    expect(extractRequestedModel('{"model":" qwen3-8b ","messages":[]}')).toBe("qwen3-8b");
  });

  it("字段缺失 / 空串 / 非字符串 / 非对象 / JSON 解不开 → null", () => {
    expect(extractRequestedModel('{"messages":[]}')).toBeNull();
    expect(extractRequestedModel('{"model":"  "}')).toBeNull();
    expect(extractRequestedModel('{"model":42}')).toBeNull();
    expect(extractRequestedModel('["model"]')).toBeNull();
    expect(extractRequestedModel("not json")).toBeNull();
  });
});

describe("requestedModelFromQuery：GET 类请求从查询串取 model", () => {
  it("有值 → 去空白返回；缺失或空白 → null", () => {
    expect(requestedModelFromQuery(new URLSearchParams("model=%20a%20"))).toBe("a");
    expect(requestedModelFromQuery(new URLSearchParams("model="))).toBeNull();
    expect(requestedModelFromQuery(new URLSearchParams(""))).toBeNull();
  });
});

describe("decideModelRoute", () => {
  const base = {
    running: ["a", "b"],
    defaultModel: "a",
    isConfigured: (name: string) => ["a", "b", "stopped"].includes(name),
  };

  it("请求的模型在跑 → 发往它", () => {
    expect(decideModelRoute({ ...base, requested: "b" })).toEqual({ kind: "route", model: "b", via: "requested" });
  });

  it("没带 model → 发往默认模型", () => {
    expect(decideModelRoute({ ...base, requested: null })).toEqual({ kind: "route", model: "a", via: "default" });
  });

  it("面板配置过但没在跑 → not-running（不静默改发到别的模型）", () => {
    expect(decideModelRoute({ ...base, requested: "stopped" })).toEqual({ kind: "not-running", model: "stopped" });
  });

  it("面板不认识的名字（客户端写死的占位名）→ 回落默认模型，标记 fallback-default", () => {
    expect(decideModelRoute({ ...base, requested: "gpt-4o" })).toEqual({
      kind: "route",
      model: "a",
      via: "fallback-default",
    });
  });

  it("没有模型在跑 → no-model（不带 model 或带未知名字都一样）", () => {
    const idle = { running: [], defaultModel: null, isConfigured: () => false };
    expect(decideModelRoute({ ...idle, requested: null })).toEqual({ kind: "no-model" });
    expect(decideModelRoute({ ...idle, requested: "gpt-4o" })).toEqual({ kind: "no-model" });
  });

  it("没有模型在跑但请求的是配置过的模型 → not-running（比 no-model 信息更具体）", () => {
    const idle = { running: [], defaultModel: null, isConfigured: (n: string) => n === "a" };
    expect(decideModelRoute({ ...idle, requested: "a" })).toEqual({ kind: "not-running", model: "a" });
  });
});
