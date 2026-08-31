import { describe, expect, it } from "vitest";

import { MODELS_TABS, resolveModelsTab } from "./models-tabs";

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
      ["configs", "01", "/models"],
      ["repos", "02", "/models/repos"],
    ]);
  });
});
