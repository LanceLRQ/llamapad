import { describe, expect, it } from "vitest";

import { buildDocsRegistry, type ScannedDoc } from "./docs-registry";
import { buildDocsNav, buildDocsNavGroups, DOCS_ORDER, DOCS_SECTIONS } from "./docs-nav";

function registryOf(...docs: ScannedDoc[]) {
  return buildDocsRegistry(docs);
}

describe("DOCS_SECTIONS / DOCS_ORDER", () => {
  it("分组表摊平后就是十篇的完整顺序", () => {
    expect(DOCS_ORDER).toEqual([
      "quickstart",
      "deployment",
      "nginx",
      "models",
      "downloads",
      "files",
      "settings",
      "monitoring",
      "troubleshooting",
      "inference",
    ]);
  });

  it("每篇只归一个组，没有重复也没有遗漏", () => {
    const flat = DOCS_SECTIONS.flatMap((section) => section.slugs);
    expect(new Set(flat).size).toBe(flat.length);
  });
});

describe("buildDocsNav", () => {
  it("批 2 场景：注册表只有 quickstart 一篇，导航也只有一项", () => {
    const registry = registryOf({ lang: "zh", file: "quickstart.md", firstHeading: "快速开始" });
    const nav = buildDocsNav(registry, "zh", null);
    expect(nav).toEqual([
      { slug: "quickstart", title: "快速开始", current: false, fallback: false, section: "start" },
    ]);
  });

  it("按分组表顺序排，不按注册表 key 的插入顺序", () => {
    const registry = registryOf(
      { lang: "zh", file: "deployment.md", firstHeading: "部署" },
      { lang: "zh", file: "quickstart.md", firstHeading: "快速开始" },
    );
    const nav = buildDocsNav(registry, "zh", null);
    expect(nav.map((item) => item.slug)).toEqual(["quickstart", "deployment"]);
  });

  it("未归类的 slug 排在末尾按字母序，section 为 null", () => {
    const registry = registryOf(
      { lang: "zh", file: "quickstart.md", firstHeading: "快速开始" },
      { lang: "zh", file: "zzz-extra.md", firstHeading: "额外" },
      { lang: "zh", file: "aaa-extra.md", firstHeading: "额外2" },
    );
    const nav = buildDocsNav(registry, "zh", null);
    expect(nav.map((item) => item.slug)).toEqual(["quickstart", "aaa-extra", "zzz-extra"]);
    expect(nav.map((item) => item.section)).toEqual(["start", null, null]);
  });

  it("分组表里有、但注册表里没有的 slug 直接跳过，不出现在结果里也不报错", () => {
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
    expect(nav).toEqual([
      { slug: "quickstart", title: "快速开始", current: false, fallback: true, section: "start" },
    ]);
  });
});

describe("buildDocsNavGroups", () => {
  it("每个实际有篇目的分组给一条分隔线，落在该组首篇上", () => {
    const registry = registryOf(
      { lang: "zh", file: "quickstart.md", firstHeading: "快速开始" },
      { lang: "zh", file: "nginx.md", firstHeading: "HTTPS 反代" },
      { lang: "zh", file: "models.md", firstHeading: "模型管理" },
    );
    const groups = buildDocsNavGroups(buildDocsNav(registry, "zh", null));
    // deployment 缺失，deploy 组的落点顺延到该组实际存在的首篇 nginx
    expect(groups).toEqual([
      { beforeKey: "quickstart", section: "start" },
      { beforeKey: "nginx", section: "deploy" },
      { beforeKey: "models", section: "use" },
    ]);
  });

  it("整组都没有篇目时不产出分隔线，避免出现空标题", () => {
    const registry = registryOf({ lang: "zh", file: "quickstart.md", firstHeading: "快速开始" });
    const groups = buildDocsNavGroups(buildDocsNav(registry, "zh", null));
    expect(groups).toEqual([{ beforeKey: "quickstart", section: "start" }]);
  });

  it("未归类篇目单独起一组，不混进上一组", () => {
    const registry = registryOf(
      { lang: "zh", file: "quickstart.md", firstHeading: "快速开始" },
      { lang: "zh", file: "extra.md", firstHeading: "额外" },
    );
    const groups = buildDocsNavGroups(buildDocsNav(registry, "zh", null));
    expect(groups).toEqual([
      { beforeKey: "quickstart", section: "start" },
      { beforeKey: "extra", section: null },
    ]);
  });
});
