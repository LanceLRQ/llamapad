import { describe, expect, it } from "vitest";
import { newModelHref, parseServerParam } from "./new-model-link";

describe("newModelHref", () => {
  it("server 为空对象时不带 server 参数", () => {
    expect(newModelHref("main/a.gguf", {})).toBe("/models/new?file=main%2Fa.gguf");
  });

  it("server 非空时追加 JSON 编码的 server 参数", () => {
    const href = newModelHref("main/a.gguf", { temp: 0.6 });
    expect(href).toBe(`/models/new?file=main%2Fa.gguf&server=${encodeURIComponent(JSON.stringify({ temp: 0.6 }))}`);
  });

  it("与 parseServerParam 往返一致", () => {
    const server = { temp: 0.6, top_p: 0.95, gpu_layers: 20 };
    const href = newModelHref("main/a.gguf", server);
    const query = new URLSearchParams(href.slice(href.indexOf("?") + 1));
    expect(parseServerParam(query.get("server") ?? undefined)).toEqual(server);
  });
});

describe("parseServerParam", () => {
  it("undefined 输入返回 undefined", () => {
    expect(parseServerParam(undefined)).toBeUndefined();
  });

  it("非法 JSON 返回 undefined", () => {
    expect(parseServerParam("{not json")).toBeUndefined();
  });

  it("JSON 合法但含未知字段（strict）时返回 undefined", () => {
    expect(parseServerParam(JSON.stringify({ not_a_field: 1 }))).toBeUndefined();
  });

  it("JSON 合法但字段值不合法（超出值域）时返回 undefined", () => {
    expect(parseServerParam(JSON.stringify({ temp: 99 }))).toBeUndefined();
  });

  it("空对象返回 undefined", () => {
    expect(parseServerParam(JSON.stringify({}))).toBeUndefined();
  });

  it("合法字段值往返一致", () => {
    const server = { gpu_layers: 20, flash_attention: "on" as const };
    expect(parseServerParam(JSON.stringify(server))).toEqual(server);
  });
});
