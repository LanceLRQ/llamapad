import { describe, expect, it } from "vitest";

import { extractJson } from "./llm-json";

describe("extractJson", () => {
  it("纯 JSON 直接解析", () => {
    const result = extractJson('{"profiles":[{"temp":0.6}]}');
    expect(result?.value).toEqual({ profiles: [{ temp: 0.6 }] });
    expect(result?.repaired).toBe(false);
  });

  it("剥掉 ```json 围栏", () => {
    expect(extractJson('```json\n{"profiles":[{"temp":0.6}]}\n```')?.value).toEqual({
      profiles: [{ temp: 0.6 }],
    });
  });

  it("剥掉无语言标记的围栏", () => {
    expect(extractJson('```\n{"profiles":[{"temp":0.6}]}\n```')?.value).toEqual({
      profiles: [{ temp: 0.6 }],
    });
  });

  it("忽略 JSON 前后的废话", () => {
    expect(
      extractJson('好的，结果如下：\n{"profiles":[{"temp":0.6}]}\n希望有帮助！')?.value,
    ).toEqual({ profiles: [{ temp: 0.6 }] });
  });

  it("正确平衡嵌套花括号", () => {
    expect(extractJson('前言 {"profiles":[{"a":{"b":{"c":1}}}]} 后记')?.value).toEqual({
      profiles: [{ a: { b: { c: 1 } } }],
    });
  });

  it("字符串字面量里的花括号不参与配平", () => {
    expect(extractJson('{"profiles":[{"note":"用 {} 包起来","temp":0.6}]}')?.value).toEqual({
      profiles: [{ note: "用 {} 包起来", temp: 0.6 }],
    });
  });

  it("转义引号不打断字符串状态", () => {
    expect(extractJson('{"profiles":[{"note":"他说\\"好\\"","temp":0.6}]}')?.value).toEqual({
      profiles: [{ note: '他说"好"', temp: 0.6 }],
    });
  });

  it("被截断的 JSON 返回 null，不做补全（数组里一个完整元素都没有）", () => {
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
    expect(extractJson('用 {} 表示占位符\n{"profiles":[{"temp":0.6}]}')?.value).toEqual({
      profiles: [{ temp: 0.6 }],
    });
  });

  it("装饰花括号加上被截断的围栏，仍然返回 null", () => {
    expect(extractJson('用 {} 表示占位符\n```json\n{"temp":0.6')).toBeNull();
  });

  // 模型常见形状：先给示例围栏、再给正式结果围栏，答案在最后一段
  it("多段围栏取最后一段", () => {
    const raw =
      '示例：\n```json\n{"profiles":[{"example":true}]}\n```\n\n实际结果：\n```json\n{"profiles":[{"temp":0.6}]}\n```';
    expect(extractJson(raw)?.value).toEqual({ profiles: [{ temp: 0.6 }] });
  });

  it("只有开围栏没有闭围栏时退回全文扫描", () => {
    expect(extractJson('```json\n{"profiles":[{"temp":0.6}]}')?.value).toEqual({
      profiles: [{ temp: 0.6 }],
    });
  });

  it("字符串以转义反斜杠结尾不打断配平", () => {
    expect(extractJson('{"profiles":[{"path":"C:\\\\","temp":0.6}]}')?.value).toEqual({
      profiles: [{ path: "C:\\", temp: 0.6 }],
    });
  });

  it("整段只有一个空对象时返回 null——空对象不算可用结果", () => {
    expect(extractJson("{}")).toBeNull();
  });

  // 本任务的核心回归：最外层 { 不闭合时，不能退而抠内层碎片冒充结果——
  // 那会把"模型输出被截断"伪装成"README 里没有推荐参数"
  it("内层碎片不再冒充结果——没有 profiles 键的候选一律不算数", () => {
    expect(extractJson('{"label":"x","params":{"temp":0.6}}')).toBeNull();
  });

  describe("截断修复", () => {
    // 真机实测：Qwen3.5-4B 吐出 698 字符后被截断，只差最外层 } 没吐出来，
    // 四个 profile 元素本身全都完整。这里用两个元素复现同样的结构
    // （`{` 比 `}` 多一个、数组自己的 `]` 正常闭合）
    it("真实场景回归：结尾缺最外层 } 时丢弃末尾不完整元素后修复", () => {
      const raw =
        '{"profiles":[{"label":"Thinking mode","params":{"temperature":0.7,"top_p":0.8}},' +
        '{"label":"Instruct mode","params":{"temperature":1.0,"top_p":1.0,"top_k":40}}]';

      const result = extractJson(raw);
      expect(result?.repaired).toBe(true);
      expect(result?.value).toEqual({
        profiles: [
          { label: "Thinking mode", params: { temperature: 0.7, top_p: 0.8 } },
          { label: "Instruct mode", params: { temperature: 1.0, top_p: 1.0, top_k: 40 } },
        ],
      });
    });

    // 硬红线：修成 {"profiles":[]} 等于把"输出坏了"重新伪装成"没找到"，
    // 这正是本任务要消灭的缺陷，绝不允许
    it("一个完整元素都没有时返回 null，不修成空数组", () => {
      expect(extractJson('{"profiles":[{"label":"x","par')).toBeNull();
    });

    it("完整输入不触发修复", () => {
      const result = extractJson('{"profiles":[{"temp":0.6}]}');
      expect(result?.repaired).toBe(false);
    });

    it("结构完整但被围栏与散文包着时照常抠出，不算修复", () => {
      const raw = '好的，结果如下：\n```json\n{"profiles":[{"temp":0.6}]}\n```\n请查收';
      const result = extractJson(raw);
      expect(result?.repaired).toBe(false);
      expect(result?.value).toEqual({ profiles: [{ temp: 0.6 }] });
    });

    // 字符串里带 } 或 ] 的截断输入：修复扫描要能正确跳过字符串内部的括号，
    // 找到真正的最后一个完整元素，而不是被字符串里的假括号带偏
    it("字符串里含括号不干扰扫描", () => {
      const raw =
        '{"profiles":[{"label":"weird}brace]here","params":{"temp":0.6}},{"label":"cut';

      const result = extractJson(raw);
      expect(result?.repaired).toBe(true);
      expect(result?.value).toEqual({
        profiles: [{ label: "weird}brace]here", params: { temp: 0.6 } }],
      });
    });
  });
});
