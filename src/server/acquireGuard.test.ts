import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AcquireGuardError, assertRealPathAllowed, assertSourceAllowed } from "./acquireGuard";

describe("assertSourceAllowed", () => {
  const roots = ["/host-models", "/host-import"];

  it("models 根内放行", () => {
    expect(() => assertSourceAllowed("/host-models/loose/a.gguf", roots)).not.toThrow();
  });

  it("已配置的自定义目录内放行", () => {
    expect(() => assertSourceAllowed("/host-import/old/a.gguf", roots)).not.toThrow();
  });

  it("允许范围之外一律拒绝", () => {
    expect(() => assertSourceAllowed("/etc/passwd", roots)).toThrow(AcquireGuardError);
  });

  it("前缀相同但不是目录边界的路径要拒绝——/host-models2 不是 /host-models 的子路径", () => {
    expect(() => assertSourceAllowed("/host-models2/a.gguf", roots)).toThrow(AcquireGuardError);
  });

  it(".. 逃逸在归一化后被拒绝", () => {
    expect(() => assertSourceAllowed("/host-models/../etc/passwd", roots)).toThrow(AcquireGuardError);
  });
});

/**
 * assertRealPathAllowed：符号链接逃逸防护（真实 fs，临时目录隔离，同
 * docs.test.ts「符号链接逃逸防护」一节的做法）。assertSourceAllowed 只按
 * 字符串前缀判定，挡不住范围内的符号链接指向范围外——这里补一道基于
 * realpath 的判定，专门堵这个洞。
 */
describe("assertRealPathAllowed：符号链接逃逸防护", () => {
  let root: string;
  let outside: string;

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("链到允许范围之外的符号链接被拒绝", () => {
    root = mkdtempSync(path.join(tmpdir(), "llamapad-acquire-guard-"));
    outside = mkdtempSync(path.join(tmpdir(), "llamapad-acquire-guard-outside-"));
    writeFileSync(path.join(outside, "secret.gguf"), "不该被读到");
    const evilLink = path.join(root, "evil.gguf");
    symlinkSync(path.join(outside, "secret.gguf"), evilLink);

    expect(() => assertRealPathAllowed(evilLink, [root])).toThrow(AcquireGuardError);
  });

  it("链到允许范围内部的符号链接正常放行，不被误杀", () => {
    root = mkdtempSync(path.join(tmpdir(), "llamapad-acquire-guard-"));
    outside = mkdtempSync(path.join(tmpdir(), "llamapad-acquire-guard-outside-unused-"));
    const real = path.join(root, "real.gguf");
    writeFileSync(real, "内容");
    const alias = path.join(root, "alias.gguf");
    symlinkSync(real, alias);

    expect(() => assertRealPathAllowed(alias, [root])).not.toThrow();
  });

  it("普通文件（非符号链接）也照常放行", () => {
    root = mkdtempSync(path.join(tmpdir(), "llamapad-acquire-guard-"));
    outside = mkdtempSync(path.join(tmpdir(), "llamapad-acquire-guard-outside-unused2-"));
    const real = path.join(root, "plain.gguf");
    writeFileSync(real, "内容");

    expect(() => assertRealPathAllowed(real, [root])).not.toThrow();
  });

  it("源路径不存在时拒绝（NOT_FOUND），不当作放行处理", () => {
    root = mkdtempSync(path.join(tmpdir(), "llamapad-acquire-guard-"));
    outside = mkdtempSync(path.join(tmpdir(), "llamapad-acquire-guard-outside-unused3-"));

    expect(() => assertRealPathAllowed(path.join(root, "missing.gguf"), [root])).toThrow(AcquireGuardError);
  });
});
