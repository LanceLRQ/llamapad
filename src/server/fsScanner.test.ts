import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveModelFiles, scanTree } from "./fsScanner";

/**
 * resolveModelFiles / scanTree 测试（M1 Task 3，真实 fs，临时目录隔离）
 *
 * 目录形态约定：models 树两层 <ns>/<file>；每个用例在 tmpdir 下 mkdtempSync
 * 建独立根，afterEach 递归清理。rel 一律是相对 modelsRoot 的路径。
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "llamapad-fsScanner-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 在临时根下写入相对路径 rel、内容 bytes 字节的文件（父目录自动创建） */
function touch(rel: string, bytes: number): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, "x".repeat(bytes));
}

describe("resolveModelFiles：精确路径", () => {
  it("存在 → 单元素：rel 相对 modelsRoot、size 字节、mtime 毫秒", () => {
    touch("main/qwen3-32b-Q4_K_M.gguf", 1024);

    const r = resolveModelFiles(root, "main/qwen3-32b-Q4_K_M.gguf");

    expect(r.missing).toBe(false);
    expect(r.files).toHaveLength(1);
    expect(r.files[0].rel).toBe("main/qwen3-32b-Q4_K_M.gguf");
    expect(r.files[0].size).toBe(1024);
    expect(r.files[0].mtime).toBeGreaterThan(0);
  });

  it("不存在 → { files: [], missing: true }", () => {
    const r = resolveModelFiles(root, "main/nope.gguf");
    expect(r.files).toEqual([]);
    expect(r.missing).toBe(true);
  });
});

describe("resolveModelFiles：分片 glob（两层树 <ns>/<file>）", () => {
  it("* 通配：命中按文件名排序，不匹配的排除", () => {
    touch("main/qwen3-00003-of-00003.gguf", 300);
    touch("main/qwen3-00001-of-00003.gguf", 100);
    touch("main/qwen3-00002-of-00003.gguf", 200);
    touch("main/qwen2.5-7b.gguf", 50); // 前缀不同，不匹配

    const r = resolveModelFiles(root, "main/qwen3-*.gguf");

    expect(r.missing).toBe(false);
    expect(r.files.map((f) => f.rel)).toEqual([
      "main/qwen3-00001-of-00003.gguf",
      "main/qwen3-00002-of-00003.gguf",
      "main/qwen3-00003-of-00003.gguf",
    ]);
    expect(r.files[2].size).toBe(300);
  });

  it("? 通配单个字符", () => {
    touch("main/a1.gguf", 10);
    touch("main/abc.gguf", 20); // ? 只占一个字符，不匹配

    const r = resolveModelFiles(root, "main/a?.gguf");

    expect(r.files.map((f) => f.rel)).toEqual(["main/a1.gguf"]);
  });

  it("ns 段也可通配：*/x.gguf 命中多个命名空间，按 rel 排序", () => {
    touch("shared/x.gguf", 1);
    touch("main/x.gguf", 2);

    const r = resolveModelFiles(root, "*/x.gguf");

    expect(r.missing).toBe(false);
    expect(r.files.map((f) => f.rel)).toEqual(["main/x.gguf", "shared/x.gguf"]);
  });

  it("零命中 → { files: [], missing: true }", () => {
    touch("main/other.gguf", 1);

    const r = resolveModelFiles(root, "main/miss-*.gguf");

    expect(r.files).toEqual([]);
    expect(r.missing).toBe(true);
  });

  it("隐藏文件与隐藏目录不参与 glob 匹配", () => {
    touch("main/.hidden.gguf", 1);
    touch(".trash/evil.gguf", 1);

    const r = resolveModelFiles(root, "*/*.gguf");

    expect(r.files).toEqual([]);
    expect(r.missing).toBe(true);
  });
});

describe("resolveModelFiles：安全", () => {
  it("relPath 任一路径段为 .. → 抛 Error（防逃逸 models 根，glob 形式同样拦截）", () => {
    expect(() => resolveModelFiles(root, "../evil.gguf")).toThrow(Error);
    expect(() => resolveModelFiles(root, "main/../../evil.gguf")).toThrow(Error);
    expect(() => resolveModelFiles(root, "../*.gguf")).toThrow(Error);
  });
});

describe("scanTree：models 目录树扫描", () => {
  it("按一级目录返回命名空间与直接文件，namespace 与 files 均排序", () => {
    touch("shared/gamma.gguf", 5);
    touch("main/beta.gguf", 20);
    touch("main/alpha.gguf", 10);

    const tree = scanTree(root);

    expect(tree.map((n) => n.namespace)).toEqual(["main", "shared"]);
    expect(tree[0].files.map((f) => f.rel)).toEqual(["main/alpha.gguf", "main/beta.gguf"]);
    expect(tree[0].files[0].size).toBe(10);
    expect(tree[0].files[0].mtime).toBeGreaterThan(0);
    expect(tree[1].files[0].rel).toBe("shared/gamma.gguf");
  });

  it("跳过隐藏文件与隐藏目录（.DS_Store 之类不出现）", () => {
    touch("main/keep.gguf", 1);
    touch("main/.DS_Store", 100);
    touch(".trash/hidden.gguf", 1);

    const tree = scanTree(root);

    expect(tree.map((n) => n.namespace)).toEqual(["main"]);
    expect(tree[0].files.map((f) => f.rel)).toEqual(["main/keep.gguf"]);
  });

  it("ns 内子目录跳过，其内部文件不扫", () => {
    touch("main/nested/deep.gguf", 1);
    touch("main/top.gguf", 2);

    const tree = scanTree(root);

    expect(tree[0].files.map((f) => f.rel)).toEqual(["main/top.gguf"]);
  });

  it("根下散落文件不属于任何命名空间，不返回", () => {
    touch("loose.gguf", 1);
    expect(scanTree(root)).toEqual([]);
  });

  it("modelsRoot 不存在 → 返回空数组（不抛）", () => {
    expect(scanTree(path.join(root, "no-such-dir"))).toEqual([]);
  });
});
