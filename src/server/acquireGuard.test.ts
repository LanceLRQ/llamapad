import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AcquireGuardError, assertActionAllowed, assertSourceAllowed, resolveAllowedRealPath } from "./acquireGuard";

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

/**
 * assertActionAllowed：动作矩阵的服务端重验（I2，设计 §4.3 / D13）。
 *
 * 全部纯字符串判定（不碰 fs）：位置由调用方给出的 realSourcePath 与 modelsRoot /
 * repoDirs 推导，动作集合复用与前端同一份 actionsFor。
 */
describe("assertActionAllowed：动作矩阵重验", () => {
  const modelsRoot = "/panel-models";
  const repoDirs = ["hf/o/R", "hf/other/R2"];
  const remote = { path: "m.gguf", size: 100, oid: "a".repeat(64) };

  it("游离文件可以 move / link，也可以 download", () => {
    const ctx = { modelsRoot, realSourcePath: "/panel-models/loose/m.gguf", repoDirs };
    expect(assertActionAllowed(remote, "move", ctx)).toEqual({ inModelsRoot: true, inRepoDir: null });
    expect(() => assertActionAllowed(remote, "link", ctx)).not.toThrow();
    expect(() => assertActionAllowed(remote, "download", ctx)).not.toThrow();
  });

  // 核心防线：构造 move + 别的档案里的源 → renameSync 会把文件从那个档案搬走，
  // 且不走 fileMove 的事务重写，那个档案的模型配置当场变成悬空引用
  it("源落在别的档案目录内时拒绝 move，错误码 ACTION_NOT_ALLOWED", () => {
    const ctx = { modelsRoot, realSourcePath: "/panel-models/hf/other/R2/m.gguf", repoDirs };
    expect(() => assertActionAllowed(remote, "move", ctx)).toThrow(AcquireGuardError);
    try {
      assertActionAllowed(remote, "move", ctx);
    } catch (e) {
      expect((e as AcquireGuardError).code).toBe("ACTION_NOT_ALLOWED");
    }
  });

  it("同一个源改用 link 则放行，并回传实测到的位置（in-repo）", () => {
    const location = assertActionAllowed(remote, "link", {
      modelsRoot,
      realSourcePath: "/panel-models/hf/other/R2/m.gguf",
      repoDirs,
    });
    expect(location).toEqual({ inModelsRoot: true, inRepoDir: "hf/other/R2" });
  });

  it("models 根外的源只能 copy / move（跨挂载点没法硬链接），link 被拒", () => {
    const ctx = { modelsRoot, realSourcePath: "/mnt/import/m.gguf", repoDirs };
    expect(assertActionAllowed(remote, "copy", ctx)).toEqual({ inModelsRoot: false, inRepoDir: null });
    expect(() => assertActionAllowed(remote, "link", ctx)).toThrow(AcquireGuardError);
  });

  it("远端没有可用 oid 时任何搬运动作都被拒（L2 没有比对基准）", () => {
    const ctx = { modelsRoot, realSourcePath: "/panel-models/loose/m.gguf", repoDirs };
    expect(() => assertActionAllowed({ path: "m.gguf", size: 100 }, "move", ctx)).toThrow(AcquireGuardError);
  });

  // 目录边界判定不能是裸 startsWith：hf/o/R-extra 只是名字像，不是 hf/o/R 的子目录
  it("档案目录只按目录边界判定，前缀相似的目录不算档案内", () => {
    const location = assertActionAllowed(remote, "move", {
      modelsRoot,
      realSourcePath: "/panel-models/hf/o/R-extra/m.gguf",
      repoDirs,
    });
    expect(location.inRepoDir).toBeNull();
  });
});

/**
 * 真实 fs：models 根本身含符号链接段时（macOS 的 /var → /private/var 就是这个
 * 形态），源路径已经去过符号链接、根却没有的话，根内的文件会被误判成「根外」，
 * link 这类合法动作反而被拒。
 */
describe("assertActionAllowed：models 根含符号链接", () => {
  let base: string;

  afterEach(() => {
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it("根经符号链接给出时仍判定为 models 根内（可 link）", () => {
    base = mkdtempSync(path.join(realpathSync(tmpdir()), "llamapad-guard-root-"));
    const realRoot = path.join(base, "real-models");
    const linkRoot = path.join(base, "models-link");
    mkdirSync(path.join(realRoot, "loose"), { recursive: true });
    writeFileSync(path.join(realRoot, "loose/m.gguf"), "x");
    symlinkSync(realRoot, linkRoot);

    const location = assertActionAllowed(
      { path: "m.gguf", size: 1, oid: "a".repeat(64) },
      "link",
      {
        modelsRoot: linkRoot, // 面板配置里的根走符号链接
        realSourcePath: path.join(realRoot, "loose/m.gguf"), // 源已经 realpath 过
        repoDirs: [],
      },
    );
    expect(location).toEqual({ inModelsRoot: true, inRepoDir: null });
  });
});
