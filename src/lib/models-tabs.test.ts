import { describe, expect, it } from "vitest";

import { buildModelsTabItems, MODELS_TABS, resolveModelsTab } from "./models-tabs";

/** 桩翻译函数：只回显 key，够断言 name/meta 确实来自 t() 而不是硬编码 */
const stubT = (key: string) => `t:${key}`;

describe("resolveModelsTab", () => {
  it("/models 落 configs", () => {
    expect(resolveModelsTab("/models")).toBe("configs");
  });

  it("/models/repos 落 repos", () => {
    expect(resolveModelsTab("/models/repos")).toBe("repos");
  });

  it("/models/repos/12（详情页）落 repos", () => {
    expect(resolveModelsTab("/models/repos/12")).toBe("repos");
  });

  it("/models/new 落 configs", () => {
    expect(resolveModelsTab("/models/new")).toBe("configs");
  });

  it("/models/repos-other 落 configs（前缀不是目录边界）", () => {
    expect(resolveModelsTab("/models/repos-other")).toBe("configs");
  });
});

describe("MODELS_TABS", () => {
  it("编号固定 01–02，与 key 顺序一一对应（固定有序集合的前导位语义）", () => {
    expect(MODELS_TABS.map((tab) => [tab.key, tab.number, tab.href])).toEqual([
      ["repos", "01", "/models/repos"],
      ["configs", "02", "/models"],
    ]);
  });
});

describe("buildModelsTabItems", () => {
  it("按 pathname 判定 selected，而不是要求调用方自己算好", () => {
    const items = buildModelsTabItems("/models", stubT);
    expect(items.map((i) => [i.key, i.selected])).toEqual([
      ["repos", false],
      ["configs", true],
    ]);
  });

  it("/models/repos 与其详情页子路由都落 repos 选中", () => {
    expect(buildModelsTabItems("/models/repos", stubT).find((i) => i.key === "repos")?.selected).toBe(true);
    expect(buildModelsTabItems("/models/repos/12", stubT).find((i) => i.key === "repos")?.selected).toBe(true);
  });

  it("name/meta 经 t() 取值，键名带 tabs.<key> 前缀", () => {
    const items = buildModelsTabItems("/models", stubT);
    expect(items.find((i) => i.key === "configs")).toMatchObject({
      name: "t:tabs.configs.name",
      meta: "t:tabs.configs.meta",
    });
  });

  it("href 与编号原样透传自 MODELS_TABS", () => {
    const items = buildModelsTabItems("/models", stubT);
    expect(items.map((i) => [i.href, i.lead.text])).toEqual([
      ["/models/repos", "01"],
      ["/models", "02"],
    ]);
  });
});
