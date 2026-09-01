import { readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import type { Locale } from "@/i18n/locales";
import { locales } from "@/i18n/locales";
import { buildDocsRegistry, type DocEntry, type DocsRegistry, type ScannedDoc } from "@/lib/docs-registry";

/**
 * 文档中心读盘层（文档中心批 2）：扫描 `docs/guide/{zh,en}/*.md` 装配注册表，
 * 懒加载 + 进程内缓存（首次访问才扫，之后常驻内存——文档是随镜像发布的
 * 静态文件，运行期不会变，不需要每次请求都重新 readdir + 读正文）。
 *
 * 安全：
 * - slug 只查注册表（resolveDoc），永不用 URL 里的 slug 拼接文件路径——
 *   注册表里的 DocEntry.file 一律来自本文件扫描时的 readdirSync 结果，
 *   不是用户输入，这是防路径穿越的根治手段，不靠过滤 ".." 字符串糊墙。
 * - 符号链接逃逸防护：候选文件 realpathSync 后必须仍落在文档根前缀内，
 *   否则整个文件跳过（console.warn，不抛异常）——防止有人在 docs/guide
 *   下放一个指向仓库外的符号链接，把任意文件伪装成"文档"读出来。
 * - 目录缺失/注册表为空：console.warn 后返回空注册表，不抛异常——文档
 *   目录是随镜像发布的附属内容，面板不能因为它缺失就整站崩，页面路由层
 *   （app/(panel)/docs）据空注册表落 404。
 */

/** docs/guide 根目录：dev 下 cwd 是仓库根，Docker standalone 下 cwd 是
 * /app（批 1 已在 Dockerfile 里 COPY --from=build /app/docs/guide ./docs/guide） */
export function getDocsRoot(): string {
  return path.join(process.cwd(), "docs", "guide");
}

/** content 正文里第一个 ATX 一级标题（"# 标题"，允许行尾的收尾 #）；没有则 null */
function extractFirstHeading(content: string): string | null {
  const match = content.match(/^#[ \t]+(.+?)[ \t]*#*[ \t]*$/m);
  return match ? match[1].trim() : null;
}

/** candidate 的 realpath 是否仍落在 root 的 realpath 前缀内（含相等） */
function isWithinRoot(rootReal: string, candidateReal: string): boolean {
  return candidateReal === rootReal || candidateReal.startsWith(rootReal + path.sep);
}

/** 扫描单个语言子目录下的全部 .md 文件，返回纯数据（不做 slug/registry 装配，
 * 那是 lib/docs-registry.ts 的事）。目录不存在、root 解析失败、单个文件
 * realpath 逃逸/读取失败——一律跳过而不是抛异常，让扫描能"尽力而为"。 */
function scanLangDir(root: string, lang: Locale): ScannedDoc[] {
  const dir = path.join(root, lang);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return [];
  }

  const docs: ScannedDoc[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const abs = path.join(dir, name);

    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      console.warn(`docs: 跳过无法解析的文件 ${abs}`);
      continue;
    }
    if (!isWithinRoot(rootReal, real)) {
      console.warn(`docs: 跳过越出文档根的符号链接 ${abs}`);
      continue;
    }

    let content: string;
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      console.warn(`docs: 跳过无法读取的文件 ${abs}`);
      continue;
    }

    docs.push({ lang, file: name, firstHeading: extractFirstHeading(content) });
  }
  return docs;
}

/** 无缓存的一次性扫描（供测试与 getDocsRegistry 内部调用，root 显式传入
 * 以便测试用临时目录隔离，不依赖 process.cwd()） */
export function scanDocsRegistry(root: string): DocsRegistry {
  const scanned = locales.flatMap((lang) => scanLangDir(root, lang));
  const registry = buildDocsRegistry(scanned);
  if (Object.keys(registry).length === 0) {
    console.warn(`docs: 文档目录为空或不存在（${root}），文档中心暂不可用`);
  }
  return registry;
}

const globalForDocs = globalThis as typeof globalThis & {
  __llamapadDocsRegistry?: DocsRegistry;
};

/** 惰性单例：首次访问才扫描，之后常驻进程内存（Next 多 bundle 共享，
 * 挂 globalThis 的理由同 locators.ts 里其余单例）。
 *
 * 开发态刻意不缓存：注册表记的是「有哪些文档、各自叫什么标题」，新增一篇
 * md、改一次一级标题、或改个文件名都会让缓存过期，而 dev 下改文档是常态
 * （写文档那一批要落二十来个文件）。缓存住的话每加一篇都得重启 dev——正文
 * 是每次请求现读的，唯独"这篇文档存不存在"要重启才认，最容易让人误判成
 * 功能坏了。生产里文档随镜像发布、运行期不会变，缓存是纯收益。 */
export function getDocsRegistry(): DocsRegistry {
  if (process.env.NODE_ENV !== "production") return scanDocsRegistry(getDocsRoot());
  if (!globalForDocs.__llamapadDocsRegistry) {
    globalForDocs.__llamapadDocsRegistry = scanDocsRegistry(getDocsRoot());
  }
  return globalForDocs.__llamapadDocsRegistry;
}

/** 按注册表条目读回正文全文——entry.lang/entry.file 只可能来自扫描结果
 * （见上方安全说明），不会被 URL 输入污染 */
export function getDocBody(root: string, entry: DocEntry): string {
  return readFileSync(path.join(root, entry.lang, entry.file), "utf8");
}
