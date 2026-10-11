import { describe, expect, it } from "vitest";
import { extractRequestedModel, requestedModelFromQuery } from "./model-route";

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
