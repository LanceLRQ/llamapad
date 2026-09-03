import { describe, expect, it } from "vitest";

import { mergeRequestBody, parseExtraBody } from "./llm-extra-body";

describe("parseExtraBody", () => {
  it("解析合法 JSON 对象", () => {
    expect(parseExtraBody('{"thinking":{"type":"disabled"}}')).toEqual({
      thinking: { type: "disabled" },
    });
  });

  it("未配置返回 null", () => {
    expect(parseExtraBody(null)).toBeNull();
    expect(parseExtraBody(undefined)).toBeNull();
    expect(parseExtraBody("  ")).toBeNull();
  });

  // 非法配置不该让整个解析功能崩掉——用户填错一个字符不等于功能不可用
  it("非法 JSON 返回 null，不抛错", () => {
    expect(parseExtraBody("{不是 JSON")).toBeNull();
  });

  it("顶层不是对象一律拒绝", () => {
    expect(parseExtraBody("[1,2]")).toBeNull();
    expect(parseExtraBody('"str"')).toBeNull();
    expect(parseExtraBody("42")).toBeNull();
  });
});

describe("mergeRequestBody", () => {
  it("额外字段合并进请求体", () => {
    const out = mergeRequestBody({ thinking: { type: "disabled" } }, { model: "m", stream: true });
    expect(out).toEqual({ thinking: { type: "disabled" }, model: "m", stream: true });
  });

  // 不允许用户从这个口子改掉面板的核心请求语义
  it("面板自己的字段永远覆盖额外字段", () => {
    const out = mergeRequestBody({ model: "用户想换的", stream: false }, { model: "面板定的", stream: true });
    expect(out.model).toBe("面板定的");
    expect(out.stream).toBe(true);
  });

  it("额外字段为 null 时原样返回核心字段", () => {
    expect(mergeRequestBody(null, { model: "m" })).toEqual({ model: "m" });
  });

  // 简报点名的四个核心字段（model / messages / stream / response_format）此前只测了
  // model 和 stream，这里补齐 messages 与 response_format——同一套覆盖逻辑，不该只信一半
  it("面板自己的 messages 与 response_format 同样覆盖不掉额外字段", () => {
    const out = mergeRequestBody(
      { messages: [{ role: "user", content: "旧的" }], response_format: { type: "text" } },
      { messages: [{ role: "user", content: "面板定的" }], response_format: { type: "json_object" } },
    );
    expect(out.messages).toEqual([{ role: "user", content: "面板定的" }]);
    expect(out.response_format).toEqual({ type: "json_object" });
  });
});
