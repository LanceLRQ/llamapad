import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODEL_FORM_SECTION,
  DUPLICATE_SECTIONS,
  EDIT_SECTIONS,
  countSectionOverrides,
  resolveModelFormSection,
} from "./model-form-sections";

describe("resolveModelFormSection", () => {
  it("编辑页六个合法值原样返回", () => {
    for (const { key } of EDIT_SECTIONS) {
      expect(resolveModelFormSection(key, EDIT_SECTIONS)).toBe(key);
    }
  });

  it("另存为页五个合法值原样返回", () => {
    for (const { key } of DUPLICATE_SECTIONS) {
      expect(resolveModelFormSection(key, DUPLICATE_SECTIONS)).toBe(key);
    }
  });

  it("缺省（undefined）落到 basic", () => {
    expect(resolveModelFormSection(undefined, EDIT_SECTIONS)).toBe(DEFAULT_MODEL_FORM_SECTION);
  });

  it("非法字符串落到 basic", () => {
    expect(resolveModelFormSection("nope", EDIT_SECTIONS)).toBe(DEFAULT_MODEL_FORM_SECTION);
  });

  it("空字符串落到 basic", () => {
    expect(resolveModelFormSection("", EDIT_SECTIONS)).toBe(DEFAULT_MODEL_FORM_SECTION);
  });

  it("编辑页 ?tab=danger 解析为 danger", () => {
    expect(resolveModelFormSection("danger", EDIT_SECTIONS)).toBe("danger");
  });

  it("另存为页没有危险区，?tab=danger 必须落回 basic（不能渲染出一个这页根本不存在的分节）", () => {
    expect(resolveModelFormSection("danger", DUPLICATE_SECTIONS)).toBe("basic");
  });
});

describe("EDIT_SECTIONS / DUPLICATE_SECTIONS", () => {
  it("编辑页六格：01–05 编号 + danger 无编号（前导位是图标，不用编号）", () => {
    expect(EDIT_SECTIONS.map((s) => [s.key, s.number])).toEqual([
      ["basic", "01"],
      ["docker", "02"],
      ["perf", "03"],
      ["sampling", "04"],
      ["preview", "05"],
      ["danger", ""],
    ]);
  });

  it("另存为页五格：与编辑页前五格一致，没有危险区", () => {
    expect(DUPLICATE_SECTIONS.map((s) => s.key)).toEqual([
      "basic",
      "docker",
      "perf",
      "sampling",
      "preview",
    ]);
  });
});

describe("countSectionOverrides", () => {
  it("空集合全零", () => {
    expect(countSectionOverrides([])).toEqual({ docker: 0, perf: 0, sampling: 0, preview: 0 });
  });

  it("只有 docker 覆盖", () => {
    expect(countSectionOverrides(["docker.image", "docker.host_port"])).toEqual({
      docker: 2,
      perf: 0,
      sampling: 0,
      preview: 2,
    });
  });

  it("只有采样覆盖", () => {
    expect(countSectionOverrides(["server.temp", "server.top_p"])).toEqual({
      docker: 0,
      perf: 0,
      sampling: 2,
      preview: 2,
    });
  });

  it("性能与采样混合：六个采样键之外的 server.* 一律归性能", () => {
    expect(
      countSectionOverrides(["server.gpu_layers", "server.ctx_size", "server.temp", "docker.image"]),
    ).toEqual({ docker: 1, perf: 2, sampling: 1, preview: 4 });
  });

  it("preview 恒等于总数", () => {
    const keys = ["docker.image", "server.gpu_layers", "server.temp", "server.top_k"];
    expect(countSectionOverrides(keys).preview).toBe(keys.length);
  });
});
