import { describe, expect, it } from "vitest";
import { applyUpstreamModel } from "./upstream-forward";

describe("applyUpstreamModel", () => {
  it("覆盖已有的 model 字段，其余字段不动", () => {
    expect(JSON.parse(applyUpstreamModel('{"model":"strata","stream":true}', "qwen-real"))).toEqual({
      model: "qwen-real",
      stream: true,
    });
  });

  it("原本没有 model 字段也写入", () => {
    expect(JSON.parse(applyUpstreamModel('{"messages":[]}', "qwen-real"))).toEqual({
      messages: [],
      model: "qwen-real",
    });
  });

  it("不是 JSON 对象的请求体原样返回", () => {
    expect(applyUpstreamModel("not json", "x")).toBe("not json");
    expect(applyUpstreamModel('["a"]', "x")).toBe('["a"]');
    expect(applyUpstreamModel("", "x")).toBe("");
  });
});
