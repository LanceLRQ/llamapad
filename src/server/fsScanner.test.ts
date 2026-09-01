import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveModelFiles,
  scanTree,
  getDiskUsage,
  buildModelFileIndex,
  resolveGlobFilesFromIndex,
} from "./fsScanner";

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

  it("glob 命中的分片里混入断链符号链接不抛异常，只是不计入结果", () => {
    touch("main/qwen3-00001-of-00002.gguf", 100);
    symlinkSync(
      path.join(root, "main/does-not-exist.gguf"),
      path.join(root, "main/qwen3-00002-of-00002.gguf"),
    );

    const r = resolveModelFiles(root, "main/qwen3-*.gguf");

    expect(r.files.map((f) => f.rel)).toEqual(["main/qwen3-00001-of-00002.gguf"]);
  });
});

describe("resolveModelFiles：深层 glob（阶段 3a 新增能力）", () => {
  it("main/sub/*.gguf：目录段字面量 + 文件段通配，只命中该子目录", () => {
    touch("main/sub/model-00001-of-00002.gguf", 1);
    touch("main/sub/model-00002-of-00002.gguf", 2);
    touch("main/other.gguf", 3); // 不同目录，不该命中
    touch("main/sub/deeper/model-00003.gguf", 4); // 更深一层，不该命中（不跨目录段）

    const r = resolveModelFiles(root, "main/sub/model-*.gguf");

    expect(r.missing).toBe(false);
    expect(r.files.map((f) => f.rel)).toEqual([
      "main/sub/model-00001-of-00002.gguf",
      "main/sub/model-00002-of-00002.gguf",
    ]);
  });

  it("*/70b/*.gguf：目录段本身也可通配，多层都支持", () => {
    touch("qwen/70b/a.gguf", 1);
    touch("llama/70b/b.gguf", 2);
    touch("qwen/7b/c.gguf", 3); // 目录名不同，不该命中

    const r = resolveModelFiles(root, "*/70b/*.gguf");

    expect(r.missing).toBe(false);
    expect(r.files.map((f) => f.rel)).toEqual(["llama/70b/b.gguf", "qwen/70b/a.gguf"]);
  });

  it("段数（含文件名段）恰为 8 层仍命中", () => {
    touch("a/b/c/d/e/f/g/x.gguf", 1); // 7 层目录 + 文件名 = 8 段

    const r = resolveModelFiles(root, "a/b/c/d/e/f/g/*.gguf");

    expect(r.files.map((f) => f.rel)).toEqual(["a/b/c/d/e/f/g/x.gguf"]);
  });

  it("段数（含文件名段）超过 8 层直接零命中，不抛错", () => {
    touch("a/b/c/d/e/f/g/h/x.gguf", 1); // 8 层目录 + 文件名 = 9 段

    const r = resolveModelFiles(root, "a/b/c/d/e/f/g/h/*.gguf");

    expect(r).toEqual({ files: [], missing: true });
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
  it("按一级目录返回文件夹与直接文件，folder 与 files 均排序", () => {
    touch("shared/gamma.gguf", 5);
    touch("main/beta.gguf", 20);
    touch("main/alpha.gguf", 10);

    const tree = scanTree(root);

    expect(tree.map((n) => n.folder)).toEqual(["main", "shared"]);
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

    expect(tree.map((n) => n.folder)).toEqual(["main"]);
    expect(tree[0].files.map((f) => f.rel)).toEqual(["main/keep.gguf"]);
  });

  it("子目录作为独立目录条目返回，各自只含自己的直接文件（阶段 3a 由跳过改为展开）", () => {
    touch("main/nested/deep.gguf", 1);
    touch("main/top.gguf", 2);

    const tree = scanTree(root);
    const byFolder = new Map(tree.map((n) => [n.folder, n.files.map((f) => f.rel)]));

    expect(tree.map((n) => n.folder)).toEqual(["main", "main/nested"]);
    expect(byFolder.get("main")).toEqual(["main/top.gguf"]);
    expect(byFolder.get("main/nested")).toEqual(["main/nested/deep.gguf"]);
  });

  it("根下散落文件归入 folder: \"\" 条目（阶段 3a 由不返回改为纳入）", () => {
    touch("loose.gguf", 1);
    touch("main/a.gguf", 2);

    const tree = scanTree(root);

    expect(tree.map((n) => n.folder)).toEqual(["", "main"]);
    expect(tree[0].files.map((f) => f.rel)).toEqual(["loose.gguf"]);
  });

  it("models 根本身没有散落文件时不凭空多出 folder: \"\" 条目", () => {
    touch("main/a.gguf", 1);
    const tree = scanTree(root);
    expect(tree.map((n) => n.folder)).toEqual(["main"]);
  });

  it("modelsRoot 不存在 → 返回空数组（不抛）", () => {
    expect(scanTree(path.join(root, "no-such-dir"))).toEqual([]);
  });

  it("断链符号链接（指向不存在的路径）不让扫描抛异常，该条目被跳过，同目录正常文件仍在", () => {
    touch("main/keep.gguf", 5);
    // readdirSync 的 Dirent 用 lstat 语义，符号链接本身的 isDirectory() 为
    // false，会落进 statFile 分支；statFile 内部 statSync 跟随链接，目标
    // 路径不存在时抛 ENOENT——这正是模拟"models 根下留了指向已卸载盘的
    // 断链 symlink"的真机场景。
    symlinkSync(
      path.join(root, "main/does-not-exist.gguf"),
      path.join(root, "main/broken-link.gguf"),
    );

    const tree = scanTree(root);

    expect(tree.map((n) => n.folder)).toEqual(["main"]);
    expect(tree[0].files.map((f) => f.rel)).toEqual(["main/keep.gguf"]);
  });

  it("目录嵌套超过 8 层（含文件名段）不再展开，深层文件与目录条目都不出现", () => {
    touch("a/b/c/d/e/f/g/ok.gguf", 1); // 7 层目录 + 文件名 = 8 段，仍在上限内
    touch("a/b/c/d/e/f/g/h/deep.gguf", 1); // 8 层目录 + 文件名 = 9 段，超出上限

    const tree = scanTree(root);
    const folders = tree.map((n) => n.folder);

    expect(folders).toContain("a/b/c/d/e/f/g");
    expect(folders).not.toContain("a/b/c/d/e/f/g/h");
    expect(tree.find((n) => n.folder === "a/b/c/d/e/f/g")!.files.map((f) => f.rel)).toEqual([
      "a/b/c/d/e/f/g/ok.gguf",
    ]);
  });
});

describe("getDiskUsage：models 树磁盘占用（M1 Task 9）", () => {
  it("逐命名空间求和，usedBytes 为总计，totalBytes 为所在文件系统容量", async () => {
    touch("main/a.gguf", 1000);
    touch("main/b.gguf", 240);
    touch("other/c.gguf", 76);

    const usage = await getDiskUsage(root);

    expect(usage.usedBytes).toBe(1316);
    expect(usage.perNamespace).toEqual([
      { namespace: "main", bytes: 1240 },
      { namespace: "other", bytes: 76 },
    ]);
    expect(usage.totalBytes).not.toBeNull();
    expect(usage.totalBytes!).toBeGreaterThanOrEqual(usage.usedBytes);
  });

  it("隐藏文件不计入（与 scanTree 同规则）", async () => {
    touch("main/.DS_Store", 500);
    touch("main/a.gguf", 100);

    const usage = await getDiskUsage(root);

    expect(usage.usedBytes).toBe(100);
    expect(usage.perNamespace).toEqual([{ namespace: "main", bytes: 100 }]);
  });

  it("根不存在：usedBytes 0、perNamespace 空、totalBytes null（statfs ENOENT 容错）", async () => {
    const usage = await getDiskUsage(path.join(root, "no-such-root"));

    expect(usage).toEqual({ totalBytes: null, usedBytes: 0, perNamespace: [] });
  });

  it("子目录字节数汇总到所属一级目录，perNamespace 不冒出子目录条目（C8）", async () => {
    touch("main/a.gguf", 100);
    touch("main/sub/b.gguf", 50);
    touch("main/sub/deeper/c.gguf", 20);

    const usage = await getDiskUsage(root);

    expect(usage.usedBytes).toBe(170);
    expect(usage.perNamespace).toEqual([{ namespace: "main", bytes: 170 }]);
  });

  it("根下散落文件计入 usedBytes 总计，但不单独占一条 perNamespace 记录（C8）", async () => {
    touch("loose.gguf", 30);
    touch("main/a.gguf", 70);

    const usage = await getDiskUsage(root);

    expect(usage.usedBytes).toBe(100);
    expect(usage.perNamespace).toEqual([{ namespace: "main", bytes: 70 }]);
  });
});

describe("buildModelFileIndex + resolveGlobFilesFromIndex：glob 内存匹配（批 5，namespaces.listOverview 用）", () => {
  it("结果与 resolveModelFiles 的实时扫盘结果逐条一致：命中按 rel 排序，前缀不同的排除", () => {
    touch("main/qwen3-00003-of-00003.gguf", 300);
    touch("main/qwen3-00001-of-00003.gguf", 100);
    touch("main/qwen3-00002-of-00003.gguf", 200);
    touch("main/qwen2.5-7b.gguf", 50); // 前缀不同，不匹配

    const index = buildModelFileIndex(root);
    const files = resolveGlobFilesFromIndex(index, "main/qwen3-*.gguf");

    expect(files.map((f) => f.rel)).toEqual([
      "main/qwen3-00001-of-00003.gguf",
      "main/qwen3-00002-of-00003.gguf",
      "main/qwen3-00003-of-00003.gguf",
    ]);
    expect(files[2].size).toBe(300);
    // 与实时扫盘版本比对：同一套 globSegmentToRegExp 编译结果，结果必须逐条相等
    expect(files).toEqual(resolveModelFiles(root, "main/qwen3-*.gguf").files);
  });

  it("目录段字面量 + 文件段通配，段数不同的更深路径不误配（main/sub/*.gguf 不该跨层命中 main/sub/deeper/x.gguf）", () => {
    touch("main/sub/model-00001-of-00002.gguf", 1);
    touch("main/sub/deeper/model-00002.gguf", 2); // 更深一层，段数比 pattern 多一段
    touch("main/other.gguf", 3); // 段数比 pattern 少一段

    const index = buildModelFileIndex(root);
    const files = resolveGlobFilesFromIndex(index, "main/sub/model-*.gguf");

    expect(files.map((f) => f.rel)).toEqual(["main/sub/model-00001-of-00002.gguf"]);
    expect(files).toEqual(resolveModelFiles(root, "main/sub/model-*.gguf").files);
  });

  it("目录段本身也可通配，多层同样命中（*/70b/*.gguf）", () => {
    touch("qwen/70b/a.gguf", 1);
    touch("llama/70b/b.gguf", 2);
    touch("qwen/7b/c.gguf", 3); // 目录名不同，不该命中

    const index = buildModelFileIndex(root);
    const files = resolveGlobFilesFromIndex(index, "*/70b/*.gguf");

    expect(files.map((f) => f.rel)).toEqual(["llama/70b/b.gguf", "qwen/70b/a.gguf"]);
    expect(files).toEqual(resolveModelFiles(root, "*/70b/*.gguf").files);
  });

  it("零命中返回空数组，不抛错", () => {
    touch("main/a.gguf", 10);
    const index = buildModelFileIndex(root);

    expect(resolveGlobFilesFromIndex(index, "main/nope-*.gguf")).toEqual([]);
  });

  it("索引来自 scanTree：隐藏文件不进索引，即使 glob 本可能命中也不会带出来", () => {
    touch("main/.hidden.gguf", 10);
    touch("main/visible.gguf", 20);
    const index = buildModelFileIndex(root);

    const files = resolveGlobFilesFromIndex(index, "main/*.gguf");

    expect(files.map((f) => f.rel)).toEqual(["main/visible.gguf"]);
  });

  it("段数（含文件名段）超过 8 层直接返回空数组，不抛错（与 resolveModelFiles 同一上限）", () => {
    touch("a/b/c/d/e/f/g/h/x.gguf", 1); // 8 层目录 + 文件名 = 9 段
    const index = buildModelFileIndex(root);

    expect(resolveGlobFilesFromIndex(index, "a/b/c/d/e/f/g/h/*.gguf")).toEqual([]);
  });

  it("relPath 含 .. 段 → 抛 Error（防逃逸，与 resolveModelFiles 同一防线）", () => {
    const index = buildModelFileIndex(root);
    expect(() => resolveGlobFilesFromIndex(index, "main/../*.gguf")).toThrow(Error);
  });
});
