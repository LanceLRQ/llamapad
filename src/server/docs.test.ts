import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { getDocBody, scanDocsRegistry } from "./docs";

/**
 * scanDocsRegistry / getDocBody 测试（文档中心批 2，真实 fs，临时目录隔离，
 * 同 fsScanner.test.ts 的做法）。getDocsRegistry() 那层 globalThis 缓存
 * 单例不在此覆盖——它只是 scanDocsRegistry(getDocsRoot()) 的惰性壳，
 * 与 locators.ts 里同款单例 getter 一样不单测。
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "llamapad-docs-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(lang: "zh" | "en", file: string, content: string): void {
  const dir = path.join(root, lang);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), content);
}

describe("scanDocsRegistry：正常扫描", () => {
  it("装配出 slug → { zh, en } 注册表，标题取正文首个 h1", () => {
    write("zh", "quickstart.md", "# 快速开始\n\n正文");
    write("en", "quickstart.md", "# Quick Start\n\nbody");

    const registry = scanDocsRegistry(root);

    expect(Object.keys(registry)).toEqual(["quickstart"]);
    expect(registry.quickstart.zh?.title).toBe("快速开始");
    expect(registry.quickstart.en?.title).toBe("Quick Start");
  });

  it("非 .md 文件不进注册表", () => {
    write("zh", "quickstart.md", "# 快速开始\n");
    write("zh", "notes.txt", "不是文档");

    const registry = scanDocsRegistry(root);

    expect(Object.keys(registry)).toEqual(["quickstart"]);
  });

  it("没有 h1 时用 slug（文件名去扩展名）兜底标题", () => {
    write("zh", "nginx.md", "没有一级标题的正文");

    const registry = scanDocsRegistry(root);

    expect(registry.nginx.zh?.title).toBe("nginx");
  });
});

describe("scanDocsRegistry：容错，不抛异常", () => {
  it("整个 docs/guide 根目录不存在 → 空注册表 + console.warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const missingRoot = path.join(root, "does-not-exist");

    const registry = scanDocsRegistry(missingRoot);

    expect(registry).toEqual({});
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("只有一侧语言目录存在也不报错，只装配存在的那一侧", () => {
    write("zh", "quickstart.md", "# 快速开始\n");
    // 不建 en 目录

    const registry = scanDocsRegistry(root);

    expect(registry.quickstart.zh).toBeDefined();
    expect(registry.quickstart.en).toBeUndefined();
  });
});

describe("scanDocsRegistry：符号链接逃逸防护", () => {
  it("链到文档根之外的符号链接被跳过，并 console.warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    write("zh", "quickstart.md", "# 快速开始\n");

    const outside = mkdtempSync(path.join(tmpdir(), "llamapad-docs-outside-"));
    writeFileSync(path.join(outside, "secret.md"), "# 不该被读到\n");
    symlinkSync(path.join(outside, "secret.md"), path.join(root, "zh", "escape.md"));

    const registry = scanDocsRegistry(root);

    expect(Object.keys(registry)).toEqual(["quickstart"]);
    expect(registry.escape).toBeUndefined();
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
    rmSync(outside, { recursive: true, force: true });
  });

  it("链到文档根内部的符号链接正常收录，不被误杀", () => {
    write("zh", "quickstart.md", "# 快速开始\n");
    symlinkSync(path.join(root, "zh", "quickstart.md"), path.join(root, "zh", "alias.md"));

    const registry = scanDocsRegistry(root);

    expect(registry.alias?.zh?.title).toBe("快速开始");
  });
});

describe("getDocBody", () => {
  it("按注册表里的 lang/file 读回正文全文", () => {
    write("zh", "quickstart.md", "# 快速开始\n\n正文内容");
    const registry = scanDocsRegistry(root);
    const entry = registry.quickstart.zh!;

    expect(getDocBody(root, entry)).toBe("# 快速开始\n\n正文内容");
  });
});
