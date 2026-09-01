import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODEL_FORM_SECTION,
  DUPLICATE_SECTIONS,
  EDIT_SECTIONS,
  resolveModelFormSection,
} from "./model-form-sections";

describe("resolveModelFormSection", () => {
  it("编辑页三个合法值原样返回", () => {
    for (const { key } of EDIT_SECTIONS) {
      expect(resolveModelFormSection(key, EDIT_SECTIONS)).toBe(key);
    }
  });

  it("另存为页两个合法值原样返回", () => {
    for (const { key } of DUPLICATE_SECTIONS) {
      expect(resolveModelFormSection(key, DUPLICATE_SECTIONS)).toBe(key);
    }
  });

  it("缺省（undefined）落到 config", () => {
    expect(resolveModelFormSection(undefined, EDIT_SECTIONS)).toBe(DEFAULT_MODEL_FORM_SECTION);
  });

  it("非法字符串落到 config", () => {
    expect(resolveModelFormSection("nope", EDIT_SECTIONS)).toBe(DEFAULT_MODEL_FORM_SECTION);
  });

  it("空字符串落到 config", () => {
    expect(resolveModelFormSection("", EDIT_SECTIONS)).toBe(DEFAULT_MODEL_FORM_SECTION);
  });

  it("编辑页 ?tab=danger 解析为 danger", () => {
    expect(resolveModelFormSection("danger", EDIT_SECTIONS)).toBe("danger");
  });

  it("另存为页没有危险区，?tab=danger 必须落回 config（不能渲染出一个这页根本不存在的分节）", () => {
    expect(resolveModelFormSection("danger", DUPLICATE_SECTIONS)).toBe("config");
  });

  describe("旧四格 key 的向后兼容映射（合并成一格「配置」后仍可能被旧链接/文档带进来）", () => {
    it.each(["basic", "docker", "perf", "sampling"] as const)(
      "编辑页 ?tab=%s 落到合并后的 config，而不是巧合般命中同名的 DEFAULT",
      (legacy) => {
        expect(resolveModelFormSection(legacy, EDIT_SECTIONS)).toBe("config");
      },
    );

    it.each(["basic", "docker", "perf", "sampling"] as const)(
      "另存为页 ?tab=%s 同样落到 config",
      (legacy) => {
        expect(resolveModelFormSection(legacy, DUPLICATE_SECTIONS)).toBe("config");
      },
    );
  });
});

describe("EDIT_SECTIONS / DUPLICATE_SECTIONS", () => {
  it("编辑页三格：01 配置、02 生效参数预览、danger 无编号（前导位是图标，不用编号）", () => {
    expect(EDIT_SECTIONS.map((s) => [s.key, s.number])).toEqual([
      ["config", "01"],
      ["preview", "02"],
      ["danger", ""],
    ]);
  });

  it("另存为页两格：与编辑页前两格一致，没有危险区", () => {
    expect(DUPLICATE_SECTIONS.map((s) => s.key)).toEqual(["config", "preview"]);
  });
});
