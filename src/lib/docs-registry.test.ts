import { describe, expect, it } from "vitest";

import { buildDocsRegistry, findSlugAsymmetry, resolveDoc, type ScannedDoc } from "./docs-registry";

const QUICKSTART_ZH: ScannedDoc = { lang: "zh", file: "quickstart.md", firstHeading: "快速开始" };
const QUICKSTART_EN: ScannedDoc = { lang: "en", file: "quickstart.md", firstHeading: "Quick Start" };
const DEPLOY_ZH: ScannedDoc = { lang: "zh", file: "deployment.md", firstHeading: "部署与运维" };
const NOHEADING_ZH: ScannedDoc = { lang: "zh", file: "nginx.md", firstHeading: null };

describe("buildDocsRegistry", () => {
  it("按文件名（去扩展名）分组成 slug，两语言各自挂在 zh/en 键下", () => {
    const registry = buildDocsRegistry([QUICKSTART_ZH, QUICKSTART_EN]);
    expect(Object.keys(registry)).toEqual(["quickstart"]);
    expect(registry.quickstart.zh?.title).toBe("快速开始");
    expect(registry.quickstart.en?.title).toBe("Quick Start");
  });

  it("只有一种语言时另一侧键不存在", () => {
    const registry = buildDocsRegistry([DEPLOY_ZH]);
    expect(registry.deployment.zh).toBeDefined();
    expect(registry.deployment.en).toBeUndefined();
  });

  it("没有 h1 时用文件名（去扩展名）兜底标题", () => {
    const registry = buildDocsRegistry([NOHEADING_ZH]);
    expect(registry.nginx.zh?.title).toBe("nginx");
  });

  it("多篇文档各自独立分组", () => {
    const registry = buildDocsRegistry([QUICKSTART_ZH, DEPLOY_ZH]);
    expect(Object.keys(registry).sort()).toEqual(["deployment", "quickstart"]);
  });

  it("空输入 → 空注册表", () => {
    expect(buildDocsRegistry([])).toEqual({});
  });
});

describe("resolveDoc", () => {
  const registry = buildDocsRegistry([QUICKSTART_ZH, QUICKSTART_EN, DEPLOY_ZH]);

  it("命中当前语言：直接返回，fallback 为 false", () => {
    const resolved = resolveDoc(registry, "quickstart", "zh");
    expect(resolved).not.toBeNull();
    expect(resolved?.entry.lang).toBe("zh");
    expect(resolved?.fallback).toBe(false);
  });

  it("当前语言缺失时回退另一语言，并标记 fallback: true", () => {
    const resolved = resolveDoc(registry, "deployment", "en");
    expect(resolved).not.toBeNull();
    expect(resolved?.entry.lang).toBe("zh");
    expect(resolved?.fallback).toBe(true);
  });

  it("两种语言都没有该 slug → null", () => {
    expect(resolveDoc(registry, "nope", "zh")).toBeNull();
  });
});

describe("findSlugAsymmetry", () => {
  it("找出只有一侧语言存在的 slug，两侧各自按字母排序", () => {
    const registry = buildDocsRegistry([QUICKSTART_ZH, QUICKSTART_EN, DEPLOY_ZH]);
    const asymmetry = findSlugAsymmetry(registry);
    expect(asymmetry.zhOnly).toEqual(["deployment"]);
    expect(asymmetry.enOnly).toEqual([]);
  });

  it("完全对称时两侧都是空数组", () => {
    const registry = buildDocsRegistry([QUICKSTART_ZH, QUICKSTART_EN]);
    expect(findSlugAsymmetry(registry)).toEqual({ zhOnly: [], enOnly: [] });
  });
});
