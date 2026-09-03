import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AcquireGuardError, assertSourceAllowed, resolveAllowedRealPath } from "./acquireGuard";

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
 * resolveAllowedRealPath：符号链接逃逸防护 + TOCTOU 防护（真实 fs，临时目录
 * 隔离，同 docs.test.ts「符号链接逃逸防护」一节的做法）。assertSourceAllowed
 * 只按字符串前缀判定，挡不住范围内的符号链接指向范围外——这里补一道基于
 * realpath 的判定；返回值（而不是 void）是关键：调用方必须拿返回的规范路径
 * 去入队，而不是继续用校验前的原始路径，否则校验通过之后、任务真正执行之前
 * 这段窗口里符号链接被改指，前面的校验就形同虚设。
 */
describe("resolveAllowedRealPath：符号链接逃逸防护", () => {
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

    expect(() => resolveAllowedRealPath(evilLink, [root])).toThrow(AcquireGuardError);
  });

  it("链到允许范围内部的符号链接正常放行，返回的是链接目标的规范路径", () => {
    root = mkdtempSync(path.join(tmpdir(), "llamapad-acquire-guard-"));
    outside = mkdtempSync(path.join(tmpdir(), "llamapad-acquire-guard-outside-unused-"));
    const real = path.join(root, "real.gguf");
    writeFileSync(real, "内容");
    const alias = path.join(root, "alias.gguf");
    symlinkSync(real, alias);

    const resolved = resolveAllowedRealPath(alias, [root]);
    expect(resolved).toBe(realpathSync(real));
    // 返回值必须已经是「链接目标」本身，不能是链接文件自己——否则调用方
    // 存下这个路径也还是在存一个符号链接，TOCTOU 窗口没有被真正关上
    expect(lstatSync(resolved).isSymbolicLink()).toBe(false);
  });

  it("普通文件（非符号链接）也照常放行，返回值等于自身的规范路径", () => {
    root = mkdtempSync(path.join(tmpdir(), "llamapad-acquire-guard-"));
    outside = mkdtempSync(path.join(tmpdir(), "llamapad-acquire-guard-outside-unused2-"));
    const real = path.join(root, "plain.gguf");
    writeFileSync(real, "内容");

    expect(resolveAllowedRealPath(real, [root])).toBe(realpathSync(real));
  });

  it("源路径不存在时拒绝（NOT_FOUND），不当作放行处理", () => {
    root = mkdtempSync(path.join(tmpdir(), "llamapad-acquire-guard-"));
    outside = mkdtempSync(path.join(tmpdir(), "llamapad-acquire-guard-outside-unused3-"));

    expect(() => resolveAllowedRealPath(path.join(root, "missing.gguf"), [root])).toThrow(AcquireGuardError);
  });

  it("TOCTOU：校验通过后把符号链接改指到范围外，已捕获的返回值不受影响——" +
    "调用方必须用这个返回值去入队，而不是继续用校验前的原始路径", () => {
    root = mkdtempSync(path.join(tmpdir(), "llamapad-acquire-guard-"));
    outside = mkdtempSync(path.join(tmpdir(), "llamapad-acquire-guard-outside-"));
    const real = path.join(root, "real.gguf");
    writeFileSync(real, "合法内容");
    const secret = path.join(outside, "secret.gguf");
    writeFileSync(secret, "不该被读到");
    const link = path.join(root, "link.gguf");
    symlinkSync(real, link); // 此刻链接指向范围内，校验应当放行

    const resolvedAtCheckTime = resolveAllowedRealPath(link, [root]);
    expect(resolvedAtCheckTime).toBe(realpathSync(real));

    // 模拟 TOCTOU：校验之后、（假想中的）执行之前，攻击者把同一个符号链接
    // 改指到范围外的文件
    unlinkSync(link);
    symlinkSync(secret, link);

    // 已经捕获的规范路径是一个普通字符串，不会因为原符号链接改指而跟着变——
    // 调用方若按约定使用这个值（而不是重新读取 link），操作的仍然是校验时
    // 认定合法的那个文件，读到的是「合法内容」而不是被替换后的「不该被读到」
    expect(readFileSync(resolvedAtCheckTime, "utf8")).toBe("合法内容");

    // 反证：如果调用方没有采纳这个修复、天真地对原始 link 再走一次解析
    // （或者直接把 link 存进队列，执行器执行时才去解析），此刻会拿到范围外
    // 的路径——这正是本函数必须返回值而不是 void 的原因
    expect(() => resolveAllowedRealPath(link, [root])).toThrow(AcquireGuardError);
  });
});
