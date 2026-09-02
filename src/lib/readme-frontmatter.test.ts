import { describe, expect, it } from "vitest";

import { frontmatterBadges, splitFrontmatter } from "./readme-frontmatter";

describe("splitFrontmatter", () => {
  it("剥掉开头的 frontmatter，meta 为解析后的映射", () => {
    const raw = "---\nlicense: apache-2.0\nbase_model: Qwen/Qwen3\n---\n\n# 标题\n正文";
    const { meta, body } = splitFrontmatter(raw);
    expect(meta).toEqual({ license: "apache-2.0", base_model: "Qwen/Qwen3" });
    expect(body).toBe("# 标题\n正文");
  });

  it("正文中间的 --- 分隔线一律不动（unsloth 样本就有一条）", () => {
    const raw = "---\nlicense: mit\n---\n\n正文一\n\n---\n\n正文二";
    const { body } = splitFrontmatter(raw);
    expect(body).toBe("正文一\n\n---\n\n正文二");
  });

  it("开头的 --- 是水平线而非 frontmatter（解析结果不是映射）→ 原样返回", () => {
    const raw = "---\n\n# 标题\n\n---\n";
    const { meta, body } = splitFrontmatter(raw);
    expect(meta).toBeNull();
    expect(body).toBe(raw);
  });

  it("没有 frontmatter 时原样返回", () => {
    const raw = "# 标题\n正文";
    expect(splitFrontmatter(raw)).toEqual({ meta: null, body: raw });
  });

  it("frontmatter 未闭合 → 原样返回，不吞正文", () => {
    const raw = "---\nlicense: mit\n\n# 标题";
    expect(splitFrontmatter(raw)).toEqual({ meta: null, body: raw });
  });

  it("坏 YAML 不抛异常，退化成无 meta", () => {
    const raw = "---\nlicense: [unclosed\n---\n正文";
    const { meta, body } = splitFrontmatter(raw);
    expect(meta).toBeNull();
    expect(body).toBe("正文");
  });

  it("空字符串不抛", () => {
    expect(splitFrontmatter("")).toEqual({ meta: null, body: "" });
  });
});

describe("frontmatterBadges", () => {
  it("按固定顺序取四个展示字段，缺的跳过", () => {
    const badges = frontmatterBadges({
      license: "apache-2.0",
      pipeline_tag: "text-generation",
      base_model: "Qwen/Qwen3.8-27B",
      tags: ["gguf", "vision"],
      language: ["en"],
    });
    expect(badges).toEqual([
      { key: "license", value: "apache-2.0" },
      { key: "base_model", value: "Qwen/Qwen3.8-27B" },
      { key: "pipeline_tag", value: "text-generation" },
      { key: "tags", value: "gguf, vision" },
    ]);
  });

  it("base_model 为数组时取首个（HF 两种写法都存在）", () => {
    expect(frontmatterBadges({ base_model: ["Qwen/Qwen3.8-27B"] })).toEqual([
      { key: "base_model", value: "Qwen/Qwen3.8-27B" },
    ]);
  });

  it("meta 为 null 返回空数组", () => {
    expect(frontmatterBadges(null)).toEqual([]);
  });

  it("tags 超过 6 个只取前 6 个并加省略号", () => {
    const badges = frontmatterBadges({ tags: ["a", "b", "c", "d", "e", "f", "g"] });
    expect(badges).toEqual([{ key: "tags", value: "a, b, c, d, e, f…" }]);
  });
});
