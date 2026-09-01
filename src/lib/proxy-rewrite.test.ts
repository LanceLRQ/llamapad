import { describe, expect, it } from "vitest";
import type { EffortMappingConfig, EffortOutcome, EffortResolution } from "./effort-mapping";
import type { EffortSupport } from "./reasoning-effort";
import {
  effortHeaderValue,
  enhanceModelsResponse,
  isModelsListPath,
  isRewriteTarget,
  rewriteRequestBody,
} from "./proxy-rewrite";

/**
 * 「思考强度中转映射」接线层纯函数测试（最后一批，TDD）
 *
 * 本文件只测「要不要改写 / 怎么改写 / 改写完怎么标注」三段判定，
 * resolveEffort 本身的取整规则已在 effort-mapping.test.ts 覆盖，这里不重复。
 */

const supportedSupport: EffortSupport = { state: "supported", levels: ["low", "medium", "xhigh"] };
const config: EffortMappingConfig = { aliases: {}, rounding: "down" };

describe("isRewriteTarget：改写白名单判定", () => {
  it.each<[string, string[]]>([
    ["/v1/chat/completions", ["v1", "chat", "completions"]],
    ["/chat/completions", ["chat", "completions"]],
    ["/apply-template", ["apply-template"]],
  ])("POST + application/json 命中 %s", (_name, segments) => {
    expect(isRewriteTarget("POST", "application/json", segments)).toBe(true);
  });

  it("方法小写同样命中（大小写不敏感）", () => {
    expect(isRewriteTarget("post", "application/json", ["chat", "completions"])).toBe(true);
  });

  it("content-type 带 charset 参数同样命中", () => {
    expect(isRewriteTarget("POST", "application/json; charset=utf-8", ["chat", "completions"])).toBe(true);
  });

  it("GET 不命中（即便路径和 content-type 都对）", () => {
    expect(isRewriteTarget("GET", "application/json", ["v1", "chat", "completions"])).toBe(false);
  });

  it("非 JSON content-type 不命中", () => {
    expect(isRewriteTarget("POST", "text/plain", ["chat", "completions"])).toBe(false);
  });

  it("content-type 缺失不命中", () => {
    expect(isRewriteTarget("POST", null, ["chat", "completions"])).toBe(false);
  });

  it("白名单之外的路径不命中", () => {
    expect(isRewriteTarget("POST", "application/json", ["v1", "embeddings"])).toBe(false);
  });

  it("path 为 undefined（根路径）不命中", () => {
    expect(isRewriteTarget("POST", "application/json", undefined as unknown as string[])).toBe(false);
  });
});

describe("rewriteRequestBody：请求体改写", () => {
  it("没有 reasoning_effort 字段 → 原样返回，resolution: null", () => {
    const raw = JSON.stringify({ messages: [] });
    const result = rewriteRequestBody(raw, supportedSupport, config);
    expect(result.body).toBe(raw);
    expect(result.resolution).toBeNull();
  });

  it("字段存在但不是字符串 → 不动，不纠正客户端类型错误", () => {
    const raw = JSON.stringify({ reasoning_effort: 3 });
    const result = rewriteRequestBody(raw, supportedSupport, config);
    expect(result.body).toBe(raw);
    expect(result.resolution).toBeNull();
  });

  it("dropped → 从请求体里整段删掉该字段", () => {
    const raw = JSON.stringify({ reasoning_effort: "banana", messages: [] });
    const result = rewriteRequestBody(raw, supportedSupport, config);
    expect(result.resolution).toEqual({ outcome: "dropped" });
    expect(JSON.parse(result.body)).toEqual({ messages: [] });
  });

  it("有值替换 → 用 resolution.value 覆盖原字段", () => {
    const raw = JSON.stringify({ reasoning_effort: "high" });
    const result = rewriteRequestBody(raw, supportedSupport, config);
    expect(result.resolution).toEqual({ outcome: "rounded-down", value: "medium" });
    expect(JSON.parse(result.body)).toEqual({ reasoning_effort: "medium" });
  });

  it("已在值域内 → passthrough，字段原样但仍产出 resolution（供响应头诊断）", () => {
    const raw = JSON.stringify({ reasoning_effort: "low" });
    const result = rewriteRequestBody(raw, supportedSupport, config);
    expect(result.resolution).toEqual({ outcome: "passthrough", value: "low" });
    expect(JSON.parse(result.body)).toEqual({ reasoning_effort: "low" });
    expect(result.requested).toBe("low");
  });

  it("JSON 解析失败 → 原样返回，不报错", () => {
    const raw = "{not json";
    const result = rewriteRequestBody(raw, supportedSupport, config);
    expect(result.body).toBe(raw);
    expect(result.resolution).toBeNull();
  });

  it("JSON 根不是对象（数组）→ 原样返回，不抛错", () => {
    const raw = JSON.stringify(["a", "b"]);
    const result = rewriteRequestBody(raw, supportedSupport, config);
    expect(result.body).toBe(raw);
    expect(result.resolution).toBeNull();
  });
});

describe("effortHeaderValue：响应头诊断文案（五种 outcome 各一）", () => {
  it.each<[EffortOutcome, EffortResolution, string, string]>([
    ["passthrough", { outcome: "passthrough", value: "low" }, "low", "low->low (passthrough)"],
    ["alias", { outcome: "alias", value: "xhigh" }, "max", "max->xhigh (alias)"],
    ["rounded-down", { outcome: "rounded-down", value: "medium" }, "high", "high->medium (rounded-down)"],
    ["rounded-up", { outcome: "rounded-up", value: "xhigh" }, "max", "max->xhigh (rounded-up)"],
    ["dropped", { outcome: "dropped" }, "banana", "banana->dropped (unsupported)"],
  ])("%s", (_outcome, resolution, requested, expected) => {
    expect(effortHeaderValue(requested, resolution)).toBe(expected);
  });
});

describe("enhanceModelsResponse：/v1/models 响应增强", () => {
  it("正常注入：data[] 每一项只增不改地补 supported_parameters / x_llamapad", () => {
    const raw = JSON.stringify({ object: "list", data: [{ id: "my-model", object: "model" }] });
    const enhanced = JSON.parse(
      enhanceModelsResponse(raw, supportedSupport, { aliases: { max: "xhigh" }, rounding: "up" }),
    );
    expect(enhanced.data[0]).toEqual({
      id: "my-model",
      object: "model",
      supported_parameters: ["reasoning_effort"],
      x_llamapad: {
        reasoning_effort: {
          supported: true,
          levels: ["low", "medium", "xhigh"],
          aliases: { max: "xhigh" },
          rounding: "up",
        },
      },
    });
  });

  it("不支持时 supported_parameters 为空数组，x_llamapad.supported 为 false", () => {
    const raw = JSON.stringify({ data: [{ id: "m" }] });
    const enhanced = JSON.parse(enhanceModelsResponse(raw, { state: "unsupported", levels: null }, config));
    expect(enhanced.data[0].supported_parameters).toEqual([]);
    expect(enhanced.data[0].x_llamapad.reasoning_effort.supported).toBe(false);
    expect(enhanced.data[0].x_llamapad.reasoning_effort.levels).toBeNull();
  });

  it("JSON 解析失败 → 原样返回，不报错", () => {
    const raw = "{not json";
    expect(enhanceModelsResponse(raw, supportedSupport, config)).toBe(raw);
  });

  it("data 字段缺失 → 原样返回，不炸", () => {
    const raw = JSON.stringify({ object: "list" });
    expect(enhanceModelsResponse(raw, supportedSupport, config)).toBe(raw);
  });

  it("data 里的非对象元素原样保留（不强行补字段）", () => {
    const raw = JSON.stringify({ data: [null, "x"] });
    const enhanced = JSON.parse(enhanceModelsResponse(raw, supportedSupport, config));
    expect(enhanced.data).toEqual([null, "x"]);
  });
});

describe("isModelsListPath：/v1/models 与别名 /models 判定", () => {
  it.each<[string, string[]]>([
    ["/v1/models", ["v1", "models"]],
    ["/models", ["models"]],
  ])("%s 命中", (_name, segments) => {
    expect(isModelsListPath(segments)).toBe(true);
  });

  it("其余路径不命中", () => {
    expect(isModelsListPath(["v1", "chat", "completions"])).toBe(false);
  });

  it("undefined 不命中", () => {
    expect(isModelsListPath(undefined)).toBe(false);
  });
});
