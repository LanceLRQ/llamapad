import { describe, expect, it } from "vitest";
import { newModelHref, parseServerParam, resolveBackTarget } from "./new-model-link";

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

  it("不传 from 时产出的 URL 与既有形态逐字一致", () => {
    expect(newModelHref("main/a.gguf", { temp: 0.6 })).toBe(
      `/models/new?file=main%2Fa.gguf&server=${encodeURIComponent(JSON.stringify({ temp: 0.6 }))}`,
    );
  });

  it("传 from 时追加 &from=，顺序是 file → server → from", () => {
    const href = newModelHref("main/a.gguf", { temp: 0.6 }, "/files");
    expect(href).toBe(
      `/models/new?file=main%2Fa.gguf&server=${encodeURIComponent(JSON.stringify({ temp: 0.6 }))}&from=%2Ffiles`,
    );
  });

  it("传 from 但 server 为空对象时不冒出空的 server 参数", () => {
    expect(newModelHref("main/a.gguf", {}, "/files")).toBe("/models/new?file=main%2Fa.gguf&from=%2Ffiles");
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

describe("resolveBackTarget", () => {
  it("仓库档案页形状（纯数字 id）命中 backToRepo", () => {
    expect(resolveBackTarget("/models/repos/42")).toEqual({
      href: "/models/repos/42",
      labelKey: "backToRepo",
    });
  });

  it("文件管理页命中 backToFiles", () => {
    expect(resolveBackTarget("/files")).toEqual({ href: "/files", labelKey: "backToFiles" });
  });

  it("undefined 落默认值 backToList", () => {
    expect(resolveBackTarget(undefined)).toEqual({ href: "/models/profiles", labelKey: "backToList" });
  });

  it("空串落默认值 backToList", () => {
    expect(resolveBackTarget("")).toEqual({ href: "/models/profiles", labelKey: "backToList" });
  });

  it("仓库 id 非纯数字（非法形状）落默认值 backToList", () => {
    expect(resolveBackTarget("/models/repos/abc")).toEqual({ href: "/models/profiles", labelKey: "backToList" });
  });

  it("仓库档案路径带多余路径段落默认值 backToList", () => {
    expect(resolveBackTarget("/models/repos/1/edit")).toEqual({ href: "/models/profiles", labelKey: "backToList" });
  });

  it("协议相对 URL（站外跳转）落默认值 backToList，不原样回显", () => {
    expect(resolveBackTarget("//evil.com")).toEqual({ href: "/models/profiles", labelKey: "backToList" });
  });

  it("绝对外链（站外跳转）落默认值 backToList，不原样回显", () => {
    expect(resolveBackTarget("https://evil.com")).toEqual({ href: "/models/profiles", labelKey: "backToList" });
  });

  it("带路径穿越的仓库档案形状落默认值 backToList", () => {
    expect(resolveBackTarget("/models/repos/1/../../x")).toEqual({
      href: "/models/profiles",
      labelKey: "backToList",
    });
  });

  it("带 query 的仓库档案形状不算完全匹配，落默认值 backToList", () => {
    expect(resolveBackTarget("/models/repos/1?foo=bar")).toEqual({
      href: "/models/profiles",
      labelKey: "backToList",
    });
  });

  it("带 fragment 的仓库档案形状不算完全匹配，落默认值 backToList", () => {
    expect(resolveBackTarget("/models/repos/1#section")).toEqual({
      href: "/models/profiles",
      labelKey: "backToList",
    });
  });
});
