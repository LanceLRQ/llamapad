import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AcquireGuardError,
  assertActionAllowed,
  assertNoGlobRefOnSource,
  assertRemoteMatch,
  assertSourceAllowed,
  describeGlobExtension,
  globExtensionRefs,
  globRefsCovering,
  modelsRelOf,
  resolveAllowedRealPath,
} from "./acquireGuard";
import type { ModelRefField } from "./filesApi";

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
 * assertActionAllowed：动作矩阵的服务端重验（I2，设计 §4.3 / D13；
 * 三维扩展见规格 §4.3/§6/§7）。
 *
 * 位置由调用方给出的 realSourcePath 与 modelsRoot / repoDirs 现场实测；
 * drift（版本关系）与 referenced（引用状态）由调用方在 ctx 里直接给出——
 * 这两项在真实调用点是服务端现场实测的结果（file_meta 哈希比对 / buildRefMap），
 * 测试里直接摆事实即可，不需要真的算一遍。动作集合复用与前端同一份 actionsFor。
 */
describe("assertActionAllowed：动作矩阵重验", () => {
  const modelsRoot = "/panel-models";
  const repoDirs = ["hf/o/R", "hf/other/R2"];
  const remote = { path: "m.gguf", size: 100, oid: "a".repeat(64) };

  it("游离文件可以 move / link，也可以 download", () => {
    const ctx = {
      modelsRoot,
      realSourcePath: "/panel-models/loose/m.gguf",
      repoDirs,
      drift: "same" as const,
      referenced: false,
    };
    expect(assertActionAllowed(remote, "move", ctx)).toEqual({ inModelsRoot: true, inRepoDir: null });
    expect(() => assertActionAllowed(remote, "link", ctx)).not.toThrow();
    expect(() => assertActionAllowed(remote, "download", ctx)).not.toThrow();
  });

  // 核心防线：构造 move + 别的档案里的源 → renameSync 会把文件从那个档案搬走，
  // 且不走 fileMove 的事务重写，那个档案的模型配置当场变成悬空引用
  it("源落在别的档案目录内时拒绝 move，错误码 ACTION_NOT_ALLOWED", () => {
    const ctx = {
      modelsRoot,
      realSourcePath: "/panel-models/hf/other/R2/m.gguf",
      repoDirs,
      drift: "same" as const,
      referenced: false,
    };
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
      drift: "same",
      referenced: false,
    });
    expect(location).toEqual({ inModelsRoot: true, inRepoDir: "hf/other/R2" });
  });

  it("models 根外的源只能 copy / move（跨挂载点没法硬链接），link 被拒", () => {
    const ctx = {
      modelsRoot,
      realSourcePath: "/mnt/import/m.gguf",
      repoDirs,
      drift: "same" as const,
      referenced: false,
    };
    expect(assertActionAllowed(remote, "copy", ctx)).toEqual({ inModelsRoot: false, inRepoDir: null });
    expect(() => assertActionAllowed(remote, "link", ctx)).toThrow(AcquireGuardError);
  });

  it("远端没有可用 oid 时任何搬运动作都被拒（L2 没有比对基准）", () => {
    const ctx = {
      modelsRoot,
      realSourcePath: "/panel-models/loose/m.gguf",
      repoDirs,
      drift: "same" as const,
      referenced: false,
    };
    expect(() => assertActionAllowed({ path: "m.gguf", size: 100 }, "move", ctx)).toThrow(AcquireGuardError);
  });

  // 目录边界判定不能是裸 startsWith：hf/o/R-extra 只是名字像，不是 hf/o/R 的子目录
  it("档案目录只按目录边界判定，前缀相似的目录不算档案内", () => {
    const location = assertActionAllowed(remote, "move", {
      modelsRoot,
      realSourcePath: "/panel-models/hf/o/R-extra/m.gguf",
      repoDirs,
      drift: "same",
      referenced: false,
    });
    expect(location.inRepoDir).toBeNull();
  });

  // 引用状态维度：被引用的未归档源裸 move 会让配置悬空，必须走 move-with-refs；
  // 未被引用时反过来，move-with-refs 没有引用可改，理应被拒
  it("被配置引用的未归档源：裸 move 被拒，move-with-refs 放行", () => {
    const ctx = {
      modelsRoot,
      realSourcePath: "/panel-models/loose/m.gguf",
      repoDirs,
      drift: "same" as const,
      referenced: true,
    };
    expect(() => assertActionAllowed(remote, "move", ctx)).toThrow(AcquireGuardError);
    expect(() => assertActionAllowed(remote, "move-with-refs", ctx)).not.toThrow();
  });

  it("未被引用的未归档源：裸 move 放行，move-with-refs 被拒（没有引用可改）", () => {
    const ctx = {
      modelsRoot,
      realSourcePath: "/panel-models/loose/m.gguf",
      repoDirs,
      drift: "same" as const,
      referenced: false,
    };
    expect(() => assertActionAllowed(remote, "move", ctx)).not.toThrow();
    expect(() => assertActionAllowed(remote, "move-with-refs", ctx)).toThrow(AcquireGuardError);
  });

  // 版本关系维度：drift 一旦是 different，矩阵在检查位置之前就短路成「只能下载」——
  // 手动关联（规格 §7）才放宽这一维，常规重验里搬运动作一律被拒
  it("drift 为 different 时一切搬运动作被拒（走手动关联才放宽）", () => {
    const ctx = {
      modelsRoot,
      realSourcePath: "/panel-models/loose/m.gguf",
      repoDirs,
      drift: "different" as const,
      referenced: false,
    };
    for (const a of ["move", "link", "copy", "move-with-refs"] as const) {
      expect(() => assertActionAllowed(remote, a, ctx)).toThrow(AcquireGuardError);
    }
  });

  it("错误码是 ACTION_NOT_ALLOWED", () => {
    const ctx = {
      modelsRoot,
      realSourcePath: "/panel-models/hf/o/R/m.gguf",
      repoDirs,
      drift: "same" as const,
      referenced: false,
    };
    try {
      assertActionAllowed(remote, "move", ctx);
      throw new Error("应当抛错");
    } catch (e) {
      expect((e as AcquireGuardError).code).toBe("ACTION_NOT_ALLOWED");
    }
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
        drift: "same",
        referenced: false,
      },
    );
    expect(location).toEqual({ inModelsRoot: true, inRepoDir: null });
  });
});

/**
 * assertRemoteMatch：第二道重验（迁移设计 §8.1）。
 *
 * 配对判据与扫描侧的 matchLocalCandidate 共用 lib/acquire-match 的
 * pairsWithRemote——两处口径分家会出现「扫描给得出、提交却被拒」的自相矛盾。
 * 返回值是入队要用的 sha256：常规项必然非空（下游用 NULL 判定手动关联，
 * 这个不变量靠返回值在类型上兜住），手动关联项为 null。
 */
describe("assertRemoteMatch：源与远端条目的重验", () => {
  const OID = "a".repeat(64);
  const remote = { path: "sub/Q4_K_M.gguf", size: 2600, oid: OID };

  it("同名同大小：放行，返回远端 oid（常规项的 sha256 必然非空）", () => {
    expect(
      assertRemoteMatch(
        remote,
        { basename: "Q4_K_M.gguf", fullSha256: null, size: 2600 },
        { manual: false },
      ),
    ).toBe(OID);
  });

  it("成对但大小不符：MISMATCH", () => {
    try {
      assertRemoteMatch(
        remote,
        { basename: "Q4_K_M.gguf", fullSha256: null, size: 2599 },
        { manual: false },
      );
      throw new Error("应当抛错");
    } catch (e) {
      expect(e).toBeInstanceOf(AcquireGuardError);
      expect((e as AcquireGuardError).code).toBe("MISMATCH");
    }
  });

  // 少了配对那一半，客户端可以把任意同尺寸文件塞给任意远端条目
  it("不成对（改过名且无缓存哈希）且大小恰好相同：仍然 MISMATCH", () => {
    expect(() =>
      assertRemoteMatch(
        remote,
        { basename: "别的文件.gguf", fullSha256: null, size: 2600 },
        { manual: false },
      ),
    ).toThrow(AcquireGuardError);
  });

  it("改过名但缓存哈希等于远端 oid：成对，放行", () => {
    expect(
      assertRemoteMatch(
        remote,
        { basename: "改过名.gguf", fullSha256: OID, size: 2600 },
        { manual: false },
      ),
    ).toBe(OID);
  });

  it("远端 oid 缺失或格式非法：MISMATCH（没有可比对的内容校验值）", () => {
    const local = { basename: "Q4_K_M.gguf", fullSha256: null, size: 2600 };
    expect(() =>
      assertRemoteMatch({ path: "sub/Q4_K_M.gguf", size: 2600 }, local, { manual: false }),
    ).toThrow(AcquireGuardError);
    expect(() =>
      assertRemoteMatch(
        { path: "sub/Q4_K_M.gguf", size: 2600, oid: "not-a-sha256" },
        local,
        { manual: false },
      ),
    ).toThrow(AcquireGuardError);
  });

  it("manual：成对但大小不符也放行，且 sha256 返回 null（免比对的判据）", () => {
    expect(
      assertRemoteMatch(
        remote,
        { basename: "Q4_K_M.gguf", fullSha256: null, size: 1 },
        { manual: true },
      ),
    ).toBeNull();
  });

  // 规格 §7.1「能关联不同名的文件（本地叫 qwen38-27b.gguf 也能关联到
  // Qwen3.8-27B-UD-Q4_K_XL.gguf）」：manual 若还要求成对，改过名又没有缓存
  // 哈希的文件——手动关联最典型的处境——会被判 MISMATCH，整条逃生口就是死的
  it("manual：改过名、无缓存哈希、大小也不同，照样放行", () => {
    expect(
      assertRemoteMatch(
        remote,
        { basename: "qwen38-27b.gguf", fullSha256: null, size: 999 },
        { manual: true },
      ),
    ).toBeNull();
  });

  it("manual：远端没有可用 oid 时也不在这一道被拦（该拦的是动作矩阵）", () => {
    expect(
      assertRemoteMatch(
        { path: "sub/Q4_K_M.gguf", size: 2600 },
        { basename: "别的名字.gguf", fullSha256: null, size: 3 },
        { manual: true },
      ),
    ).toBeNull();
  });
});

/**
 * modelsRelOf：models 根内相对路径的唯一口径。assertActionAllowed 内部用它算
 * inRepoDir，acquire 路由用它算 referenced（查 buildRefMap）与 glob 预检的键——
 * 三处必须同一份，否则会出现「矩阵认为它在根内、引用表按另一个键去查」的错位。
 */
describe("modelsRelOf", () => {
  it("根内文件给出 / 分隔的相对路径", () => {
    expect(modelsRelOf("/panel-models", "/panel-models/loose/a.gguf")).toBe("loose/a.gguf");
  });

  it("根外返回 null（根外文件不可能被模型配置引用）", () => {
    expect(modelsRelOf("/panel-models", "/mnt/import/a.gguf")).toBeNull();
  });

  it("前缀相似的目录不算根内", () => {
    expect(modelsRelOf("/panel-models", "/panel-models2/a.gguf")).toBeNull();
  });

  it("路径恰好就是根本身时返回 null（没有相对路径可言）", () => {
    expect(modelsRelOf("/panel-models", "/panel-models")).toBeNull();
  });
});

/**
 * 落盘前的 glob 预检（本地权重迁移最终审查 I-2 / I-4）。
 *
 * 两侧共用 globRefsCovering，判据是「这个 glob 真的覆盖这个路径」而不是
 * 「库里存在任意 glob」——后者会因为库里有个无关的分片组就误伤无关的单文件操作。
 */
describe("globRefsCovering / assertNoGlobRefOnSource：源侧 glob 拦截（I-2）", () => {
  const fields: ModelRefField[] = [
    { modelName: "x", field: "gguf_file", configured: "loose/w-*.gguf" },
    { modelName: "y", field: "gguf_file", configured: "other/z-*.gguf" },
    { modelName: "z", field: "mmproj_file", configured: "loose/mmproj.gguf" },
  ];

  it("源被分片 glob 覆盖：拒绝，错误码 ACTION_NOT_ALLOWED，消息指向「归位」", () => {
    try {
      assertNoGlobRefOnSource(fields, "loose/w-00003-of-00003.gguf");
      throw new Error("应当抛错");
    } catch (e) {
      expect(e).toBeInstanceOf(AcquireGuardError);
      expect((e as AcquireGuardError).code).toBe("ACTION_NOT_ALLOWED");
      expect((e as AcquireGuardError).message).toContain("loose/w-*.gguf");
      expect((e as AcquireGuardError).message).toContain("归位");
    }
  });

  // 上一轮踩过的坑：不能因为库里存在别的 glob 就把无关的单文件移动一并拦下
  it("库里有 glob 但覆盖的是别的目录：放行", () => {
    expect(() => assertNoGlobRefOnSource(fields, "loose/single.gguf")).not.toThrow();
    expect(globRefsCovering(fields, "loose/single.gguf")).toEqual([]);
  });

  it("精确引用不拦——改写精确引用正是 move-with-refs 该做的事", () => {
    expect(() => assertNoGlobRefOnSource(fields, "loose/mmproj.gguf")).not.toThrow();
  });

  it("段数不同的 glob 不算覆盖（hf/u/r/*.gguf 不会命中 loose/a.gguf）", () => {
    const nested: ModelRefField[] = [
      { modelName: "n", field: "gguf_file", configured: "hf/u/r/*.gguf" },
    ];
    expect(globRefsCovering(nested, "loose/a.gguf")).toEqual([]);
  });

  it("命中的是原始配置值本身（供消息里原样说清是哪条 glob）", () => {
    expect(globRefsCovering(fields, "loose/w-00001-of-00003.gguf")).toEqual([
      { modelName: "x", field: "gguf_file", configured: "loose/w-*.gguf" },
    ]);
  });
});

describe("globExtensionRefs / describeGlobExtension：目标侧静默扩组（I-4）", () => {
  const fields: ModelRefField[] = [
    { modelName: "x", field: "gguf_file", configured: "hf/u/r/w-*.gguf" },
    { modelName: "exact", field: "gguf_file", configured: "hf/u/r/w-00003-of-00003.gguf" },
  ];
  const targetRel = "hf/u/r/w-00003-of-00003.gguf";

  // 实测复现过的场景：模型 x 移动前解析 2 片，把第三片搬进 hf/u/r/ 之后变 3 片，
  // 而事件表里只有入队与完成，零提示
  it("目标尚未存在且被既有 glob 覆盖：给出被牵连的模型配置", () => {
    expect(globExtensionRefs(fields, targetRel, false)).toEqual([
      { modelName: "x", field: "gguf_file", configured: "hf/u/r/w-*.gguf" },
    ]);
  });

  it("目标已存在：覆盖或跳过，模型的文件集合不会变大，不算扩组", () => {
    expect(globExtensionRefs(fields, targetRel, true)).toEqual([]);
  });

  it("只有 glob 形态算扩组：精确配置指向同一路径不产生提示", () => {
    const exactOnly: ModelRefField[] = [
      { modelName: "exact", field: "gguf_file", configured: targetRel },
    ];
    expect(globExtensionRefs(exactOnly, targetRel, false)).toEqual([]);
  });

  it("落点在别的目录时不误报", () => {
    expect(globExtensionRefs(fields, "hf/other/repo/w-00003-of-00003.gguf", false)).toEqual([]);
  });

  it("事件文案说清落点、被牵连的模型与那条 glob", () => {
    const message = describeGlobExtension(targetRel, globExtensionRefs(fields, targetRel, false));
    expect(message).toContain(targetRel);
    expect(message).toContain("x");
    expect(message).toContain("hf/u/r/w-*.gguf");
  });
});
