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

  // 散文里的装饰花括号不能冒充答案：返回 {} 是"假成功"——下游会诊断成
  // "模型没找到参数"，而真实原因是它根本没读到真正的 JSON
  it("跳过散文里的空花括号，取后面真正的 JSON", () => {
    expect(extractJson('用 {} 表示占位符\n{"temp":0.6}')).toEqual({ temp: 0.6 });
  });

  it("装饰花括号加上被截断的围栏，仍然返回 null", () => {
    expect(extractJson('用 {} 表示占位符\n```json\n{"temp":0.6')).toBeNull();
  });

  // 模型常见形状：先给示例围栏、再给正式结果围栏，答案在最后一段
  it("多段围栏取最后一段", () => {
    const raw = '示例：\n```json\n{"example":true}\n```\n\n实际结果：\n```json\n{"temp":0.6}\n```';
    expect(extractJson(raw)).toEqual({ temp: 0.6 });
  });

  it("只有开围栏没有闭围栏时退回全文扫描", () => {
    expect(extractJson('```json\n{"temp":0.6}')).toEqual({ temp: 0.6 });
  });

  it("字符串以转义反斜杠结尾不打断配平", () => {
    expect(extractJson('{"path":"C:\\\\","temp":0.6}')).toEqual({ path: "C:\\", temp: 0.6 });
  });

  it("整段只有一个空对象时返回 null——空对象不算可用结果", () => {
    expect(extractJson("{}")).toBeNull();
  });
});
