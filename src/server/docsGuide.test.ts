import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { locales } from "@/i18n/locales";
import { parse as parseYaml } from "yaml";
import { defaultConfigSchema, modelSchema } from "@/core/schemas";
import { rewriteDocLink } from "@/lib/docs-links";
import { DOCS_SECTIONS } from "@/lib/docs-nav";
import { pathForGroup } from "@/lib/model-file-picker";
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
 * 6. 示例与真实行为漂移——文档里的分片 glob 与 YAML 示例都是给人照抄的，
 *    抄错了要到启动失败或导入报错才暴露。这两条钉住的不是措辞而是形态：
 *    glob 比对 pathForGroup 真实产出，YAML 喂给真实 zod schema
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

describe("给人照抄的示例不能与真实行为漂移", () => {
  /** 文档与界面文案里出现的示例都要照抄得能用，所以一起扫 */
  const sources = [
    ...locales.flatMap((lang) =>
      presentSlugs(lang).map((slug) => ({
        where: `${lang}/${slug}.md`,
        text: readBody(lang, slug) ?? "",
      })),
    ),
    ...locales.map((lang) => ({
      where: `i18n/${lang}.json`,
      text: readFileSync(path.join(process.cwd(), "src", "i18n", "messages", `${lang}.json`), "utf8"),
    })),
  ];

  it("分片 glob 示例的通配符替换整段序号尾缀", () => {
    // 反例形态：通配符在前、序号写死在后（`…-*-00001-of-00002.gguf`）。这种
    // pattern 至多匹配到第一片，而面板自己产出的是 `<前缀>-*.gguf`——两者不一致时
    // 用户照文档手写的配置与界面生成的不是同一种东西。曾经文档与界面文案同时写错，
    // 且文档正是抄的界面，所以两边一起守。
    const wrong = /\*-\d{5}-of-\d{5}\.gguf/;
    const hits = sources.filter((s) => wrong.test(s.text)).map((s) => s.where);
    expect(hits).toEqual([]);
  });

  it("示例 glob 与 pathForGroup 的真实产出同形", () => {
    // 真实产出取一个具体分片名推一次，避免把"形态"重新写成一条正则又漂一次
    const produced = pathForGroup([{ path: "main/Demo-Q4_K_M-00001-of-00003.gguf" }]);
    expect(produced).toBe("main/Demo-Q4_K_M-*.gguf");

    const suffix = produced.slice(produced.lastIndexOf("-"));
    const globs = sources.flatMap((s) => [...s.text.matchAll(/[\w./-]*\*[\w./-]*\.gguf/g)].map((m) => ({ where: s.where, glob: m[0] })));
    expect(globs.filter((g) => !g.glob.endsWith(suffix)).map((g) => `${g.where}: ${g.glob}`)).toEqual([]);
  });
});

describe.each(locales)("%s config.md 的 YAML 示例能被真实 schema 接受", (lang) => {
  const blocks = [...(readBody(lang, "config") ?? "").matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]);

  it("完整示例的 default_config 与 models 都通过校验", () => {
    // 用户会整段复制这份示例去改。schema 一旦收紧而示例没跟上，
    // 照抄的人会在导入那一步撞一个没头没脑的字段报错
    const doc = parseYaml(blocks[0]) as { default_config: unknown; models: unknown[] };
    const dc = defaultConfigSchema.safeParse(doc.default_config);
    expect(dc.success ? [] : dc.error.issues.map((i) => `default_config.${i.path.join(".")}: ${i.message}`)).toEqual([]);
    for (const model of doc.models) {
      const r = modelSchema.safeParse(model);
      expect(r.success ? [] : r.error.issues.map((i) => `models.${i.path.join(".")}: ${i.message}`)).toEqual([]);
    }
  });
});
