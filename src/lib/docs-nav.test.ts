import { describe, expect, it } from "vitest";

import { buildDocsRegistry, type ScannedDoc } from "./docs-registry";
import { buildDocsNav, DOCS_ORDER } from "./docs-nav";

function registryOf(...docs: ScannedDoc[]) {
  return buildDocsRegistry(docs);
}

describe("DOCS_ORDER", () => {
  it("固定顺序表包含批 3 规划的全部 10 篇", () => {
    expect(DOCS_ORDER).toEqual([
      "quickstart",
      "deployment",
      "nginx",
      "models",
      "downloads",
      "files",
      "monitoring",
      "inference",
      "settings",
      "troubleshooting",
    ]);
  });
});

describe("buildDocsNav", () => {
  it("批 2 场景：注册表只有 quickstart 一篇，导航也只有一项", () => {
    const registry = registryOf({ lang: "zh", file: "quickstart.md", firstHeading: "快速开始" });
    const nav = buildDocsNav(registry, "zh", null);
    expect(nav).toEqual([{ slug: "quickstart", title: "快速开始", current: false, fallback: false }]);
  });

  it("按 DOCS_ORDER 排序，不按注册表 key 的插入顺序", () => {
    const registry = registryOf(
      { lang: "zh", file: "deployment.md", firstHeading: "部署" },
      { lang: "zh", file: "quickstart.md", firstHeading: "快速开始" },
    );
    const nav = buildDocsNav(registry, "zh", null);
    expect(nav.map((item) => item.slug)).toEqual(["quickstart", "deployment"]);
  });

  it("顺序表里没有的 slug 排在末尾，按字母序", () => {
    const registry = registryOf(
      { lang: "zh", file: "quickstart.md", firstHeading: "快速开始" },
      { lang: "zh", file: "zzz-extra.md", firstHeading: "额外" },
      { lang: "zh", file: "aaa-extra.md", firstHeading: "额外2" },
    );
    const nav = buildDocsNav(registry, "zh", null);
    expect(nav.map((item) => item.slug)).toEqual(["quickstart", "aaa-extra", "zzz-extra"]);
  });

  it("顺序表里有、但注册表里没有的 slug 直接跳过，不出现在结果里也不报错", () => {
    const registry = registryOf({ lang: "zh", file: "quickstart.md", firstHeading: "快速开始" });
    const nav = buildDocsNav(registry, "zh", null);
    expect(nav.some((item) => item.slug === "deployment")).toBe(false);
  });

  it("current 标记当前浏览的 slug", () => {
    const registry = registryOf(
      { lang: "zh", file: "quickstart.md", firstHeading: "快速开始" },
      { lang: "zh", file: "deployment.md", firstHeading: "部署" },
    );
    const nav = buildDocsNav(registry, "zh", "deployment");
    expect(nav.find((item) => item.slug === "quickstart")?.current).toBe(false);
    expect(nav.find((item) => item.slug === "deployment")?.current).toBe(true);
  });

  it("currentSlug 为 null 时全部 current: false", () => {
    const registry = registryOf({ lang: "zh", file: "quickstart.md", firstHeading: "快速开始" });
    const nav = buildDocsNav(registry, "zh", null);
    expect(nav.every((item) => item.current === false)).toBe(true);
  });

  it("语言缺失时回退，标题取回退语言，并标记 fallback: true", () => {
    const registry = registryOf({ lang: "zh", file: "quickstart.md", firstHeading: "快速开始" });
    const nav = buildDocsNav(registry, "en", null);
    expect(nav).toEqual([{ slug: "quickstart", title: "快速开始", current: false, fallback: true }]);
  });
});
