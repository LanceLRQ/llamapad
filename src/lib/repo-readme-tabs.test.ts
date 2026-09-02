import { describe, expect, it } from "vitest";

import {
  REPO_README_LANDING_KEY,
  buildRepoViewItems,
  parseLandingSetting,
  resolveRepoView,
} from "./repo-readme-tabs";

const stubT = (key: string) => `t:${key}`;

describe("parseLandingSetting", () => {
  it("未设置视为落地 README（新用户第一次进来该看到模型卡）", () => {
    expect(parseLandingSetting(undefined)).toBe(true);
  });

  it('"0" 表示不落地 README', () => {
    expect(parseLandingSetting("0")).toBe(false);
  });

  it('"1" 表示落地 README', () => {
    expect(parseLandingSetting("1")).toBe(true);
  });

  it("非法值按缺省处理，不抛", () => {
    expect(parseLandingSetting("maybe")).toBe(true);
  });
});

describe("resolveRepoView", () => {
  it("URL 显式给了 files 就听 URL，跟落地设置无关", () => {
    expect(resolveRepoView("files", true)).toBe("files");
  });

  it("URL 显式给了 readme 就听 URL", () => {
    expect(resolveRepoView("readme", false)).toBe("readme");
  });

  it("URL 没给时按落地设置", () => {
    expect(resolveRepoView(undefined, true)).toBe("readme");
    expect(resolveRepoView(undefined, false)).toBe("files");
  });

  it("URL 给了非法值时按落地设置，不白屏", () => {
    expect(resolveRepoView("nope", false)).toBe("files");
  });
});

describe("buildRepoViewItems", () => {
  it("两条 query 项，selected 按当前视图", () => {
    const items = buildRepoViewItems("readme", stubT);
    expect(items.map((i) => [i.key, i.selected, i.lead])).toEqual([
      ["readme", true, { kind: "number", text: "01" }],
      ["files", false, { kind: "number", text: "02" }],
    ]);
  });

  it("名称与副标题都来自 t()，不硬编码中文", () => {
    const items = buildRepoViewItems("files", stubT);
    expect(items[1].name).toBe("t:views.files.name");
    expect(items[1].meta).toBe("t:views.files.meta");
  });

  it("不带 href——它们是同页视图切换，不是路由跳转", () => {
    for (const item of buildRepoViewItems("readme", stubT)) {
      expect(item).not.toHaveProperty("href");
    }
  });
});

describe("REPO_README_LANDING_KEY", () => {
  it("键名与 settings 白名单一致", () => {
    expect(REPO_README_LANDING_KEY).toBe("repo_readme_landing");
  });
});
