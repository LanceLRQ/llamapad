import { describe, expect, it } from "vitest";

import { MODELS_TABS, resolveModelsTab } from "./models-tabs";

describe("resolveModelsTab", () => {
  it("/models 落 home（只有恰好等于才算）", () => {
    expect(resolveModelsTab("/models")).toBe("home");
  });

  it("/models/profiles 落 configs", () => {
    expect(resolveModelsTab("/models/profiles")).toBe("configs");
  });

  it("/models/repos 落 repos", () => {
    expect(resolveModelsTab("/models/repos")).toBe("repos");
  });

  it("/models/repos/12（详情页）落 repos", () => {
    expect(resolveModelsTab("/models/repos/12")).toBe("repos");
  });

  it("/models/new 落 configs——编辑流程中二级栏该高亮「配置」而不是「首页」", () => {
    expect(resolveModelsTab("/models/new")).toBe("configs");
  });

  it("/models/llama3/edit 落 configs（同上）", () => {
    expect(resolveModelsTab("/models/llama3/edit")).toBe("configs");
  });

  it("/models/repos-other 落 configs（前缀不是目录边界）", () => {
    expect(resolveModelsTab("/models/repos-other")).toBe("configs");
  });
});

describe("MODELS_TABS", () => {
  it("编号固定 01–03，与 key 顺序一一对应（固定有序集合的前导位语义）", () => {
    expect(MODELS_TABS.map((tab) => [tab.key, tab.number, tab.href])).toEqual([
      ["home", "01", "/models"],
      ["repos", "02", "/models/repos"],
      ["configs", "03", "/models/profiles"],
    ]);
  });
});
