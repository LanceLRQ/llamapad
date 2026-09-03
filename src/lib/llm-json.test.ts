import { describe, expect, it } from "vitest";

import { extractJson } from "./llm-json";

describe("extractJson", () => {
  it("纯 JSON 直接解析", () => {
    expect(extractJson('{"temp":0.6}')).toEqual({ temp: 0.6 });
  });

  it("剥掉 ```json 围栏", () => {
    expect(extractJson('```json\n{"temp":0.6}\n```')).toEqual({ temp: 0.6 });
  });

  it("剥掉无语言标记的围栏", () => {
    expect(extractJson('```\n{"temp":0.6}\n```')).toEqual({ temp: 0.6 });
  });

  it("忽略 JSON 前后的废话", () => {
    expect(extractJson('好的，结果如下：\n{"temp":0.6}\n希望有帮助！')).toEqual({ temp: 0.6 });
  });

  it("正确平衡嵌套花括号", () => {
    expect(extractJson('前言 {"a":{"b":{"c":1}}} 后记')).toEqual({ a: { b: { c: 1 } } });
  });

  it("字符串字面量里的花括号不参与配平", () => {
    expect(extractJson('{"note":"用 {} 包起来","temp":0.6}')).toEqual({
      note: "用 {} 包起来",
      temp: 0.6,
    });
  });

  it("转义引号不打断字符串状态", () => {
    expect(extractJson('{"note":"他说\\"好\\"","temp":0.6}')).toEqual({
      note: '他说"好"',
      temp: 0.6,
    });
  });

  it("被截断的 JSON 返回 null，不做补全", () => {
    expect(extractJson('{"profiles":[{"temp":0.6')).toBeNull();
  });

  it("完全不是 JSON 返回 null", () => {
    expect(extractJson("在英文句子中，要抠出 temperature: 0.6，通常可以理解为…")).toBeNull();
  });

  it("空串返回 null", () => {
    expect(extractJson("")).toBeNull();
  });

  it("只有数组不接受——契约要求顶层是对象", () => {
    expect(extractJson("[1,2,3]")).toBeNull();
  });
});
