import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { locales } from "@/i18n/locales";
import { rewriteDocLink } from "@/lib/docs-links";
import { DOCS_SECTIONS } from "@/lib/docs-nav";
import { findSlugAsymmetry } from "@/lib/docs-registry";
import { getDocsRoot, scanDocsRegistry } from "./docs";

/**
 * 文档中心正文的内容守卫——测的不是代码，是 `docs/guide/` 里那批 md 本身。
 *
 * 这四类错误的共同点是「写的时候不会发现、上线才暴露」，而中英双语二十来个
 * 文件靠人眼复查必漏：
 * 1. 中英 slug 不对称——加了中文忘了英文，切语言时那一篇静默回退，作者不会察觉
 * 2. 缺一级标题——目录项与页头会退化成用文件名兜底，看起来像正常内容
 * 3. 死链——改名或删篇之后，指向它的链接会落 404
 * 4. 内部信息外泄——素材来自内部资料，内网 IP / 部署绝对路径 / 开发期编号
 *    很容易被顺手抄进来
 * 5. 新篇目漏归类——分组表没收录时目录仍会渲染它（落"其他"组兜底），
 *    页面不报错、看着也正常，只有对着目录一项项数才会发现它排在了组外
 *
 * 与 docs.test.ts 分开：那边用临时目录测扫描逻辑本身（改代码才会红），
 * 这边扫真实文档目录（改文档才会红），红了要修的东西完全不同。
 */

const root = getDocsRoot();
const registry = scanDocsRegistry(root);
const slugs = Object.keys(registry);

/** 正文里的 markdown 链接目标：[text](target)，跳过图片（前面带 !） */
function linkTargets(body: string): string[] {
  return [...body.matchAll(/(!?)\[[^\]]*\]\(([^)\s]+)\)/g)]
    .filter((m) => m[1] !== "!")
    .map((m) => m[2]);
}

/** 该语言下这篇不存在时返回 null——缺哪一侧由「中英对称」那条统一报，
 * 其余检查跳过缺失项，免得一次漏译在每条检查里各炸一遍、盖住真正的问题 */
function readBody(lang: (typeof locales)[number], slug: string): string | null {
  try {
    return readFileSync(path.join(root, lang, `${slug}.md`), "utf8");
  } catch {
    return null;
  }
}

/** 该语言下真实存在的篇目 */
function presentSlugs(lang: (typeof locales)[number]): string[] {
  return slugs.filter((slug) => registry[slug][lang] !== undefined);
}

it("docs/guide 不是空的（守卫本身没有因为路径错误而空转）", () => {
  expect(slugs.length).toBeGreaterThan(0);
});

describe("中英对称", () => {
  it("两侧 slug 集合完全一致", () => {
    const { zhOnly, enOnly } = findSlugAsymmetry(registry);
    // 断言写成对象而非两条 toEqual([])：失败信息里能同时看到两侧缺什么
    expect({ 只有中文版: zhOnly, 只有英文版: enOnly }).toEqual({
      只有中文版: [],
      只有英文版: [],
    });
  });
});

describe.each(locales)("%s 正文", (lang) => {
  it("每篇首个非空行都是一级标题", () => {
    const missing = presentSlugs(lang).filter((slug) => {
      const first = readBody(lang, slug)?.split("\n").find((line) => line.trim() !== "");
      return first === undefined || !/^#[ \t]+\S/.test(first);
    });
    expect(missing).toEqual([]);
  });

  it("站内链接都指向存在的篇目（无死链）", () => {
    const dead: string[] = [];
    for (const slug of presentSlugs(lang)) {
      for (const target of linkTargets(readBody(lang, slug) ?? "")) {
        const result = rewriteDocLink(target);
        if (result.kind !== "doc") continue;
        // rewriteDocLink 产出 /docs/<slug>[#锚点]，取回 slug 段比对注册表
        const linked = result.href.slice("/docs/".length).split("#")[0];
        if (!slugs.includes(linked)) dead.push(`${slug}.md → ${target}`);
      }
    }
    expect(dead).toEqual([]);
  });

  it("不含内网地址、真机部署路径或开发期编号", () => {
    // 只拦「具体某台主机」的 RFC1918 地址：四段且后面不跟 /，因此
    // nginx 篇里 `allow 192.168.0.0/16; allow 10.0.0.0/8;` 这种网段 ACL 示例
    // 不会被误杀——那是文档正当内容，不是泄漏出来的内网地址。
    // 另拦本机绝对路径（部署目录与开发工作目录都算——后者曾被编辑工具拼进
    // 一条升级命令里，原样发出去会让读者照着 cd 到一个不存在的目录），
    // 以及给维护者看的开发期编号（里程碑/批次/commit）
    const forbidden =
      /(?<![\d.])(?:10|192\.168)\.\d{1,3}\.\d{1,3}\.\d{1,3}(?!\/)|\/mnt\/data\/(apps|github)|里程碑|批 \d|commit [0-9a-f]{7}/;
    const hits: string[] = [];
    for (const slug of presentSlugs(lang)) {
      (readBody(lang, slug) ?? "")
        .split("\n")
        .forEach((line, i) => {
          if (forbidden.test(line)) hits.push(`${lang}/${slug}.md:${i + 1}`);
        });
    }
    expect(hits).toEqual([]);
  });
});

it("每一篇都归进了某个分组（没有落到「其他」兜底组）", () => {
  const classified = new Set(DOCS_SECTIONS.flatMap((section) => section.slugs));
  expect(slugs.filter((slug) => !classified.has(slug))).toEqual([]);
});

it("分组表里没有已不存在的篇目", () => {
  const present = new Set(slugs);
  const stale = DOCS_SECTIONS.flatMap((section) => section.slugs).filter((slug) => !present.has(slug));
  expect(stale).toEqual([]);
});
