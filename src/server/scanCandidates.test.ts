import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectScanCandidates, type ScanCandidatesArgs } from "./scanCandidates";

/**
 * collectScanCandidates 测试（任务 12，真实 fs，临时目录隔离——同
 * fsScanner.test.ts 的既有约定）。
 *
 * toHost/toPanel 用简单前缀替换的假实现，不依赖 panelConfig/pathMaps 单例，
 * 保持本模块纯粹按注入函数测试。
 */

let modelsRoot: string;
let extraRoot: string;

beforeEach(() => {
  modelsRoot = mkdtempSync(path.join(tmpdir(), "llamapad-scan-models-"));
  extraRoot = mkdtempSync(path.join(tmpdir(), "llamapad-scan-extra-"));
});

afterEach(() => {
  rmSync(modelsRoot, { recursive: true, force: true });
  rmSync(extraRoot, { recursive: true, force: true });
});

function touch(root: string, rel: string, bytes = 10): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, "x".repeat(bytes));
}

/** panel 路径原样加个 "HOST:" 前缀冒充宿主机路径，只用来断言 hostPath 确实由 toHost 产出 */
function fakeToHost(panelPath: string): string {
  return `HOST:${panelPath}`;
}

/** 默认入参夹具：modelsRoot 取当次 beforeEach 生成的临时目录，其余字段给
 *  最保守的空值（无自定义目录/无档案/无缓存/无引用），toPanel 恒等映射。
 *  各用例按需覆盖，不必每次重复整份对象 */
function makeArgs(overrides: Partial<ScanCandidatesArgs> = {}): ScanCandidatesArgs {
  return {
    modelsRoot,
    extraHostDirs: [],
    repoDirs: [],
    fullSha256ByRel: new Map(),
    referencedRels: new Set(),
    toHost: fakeToHost,
    toPanel: (p) => p,
    ...overrides,
  };
}

describe("collectScanCandidates：models 根", () => {
  it("空 models 树返回空候选、无 unreachable", () => {
    const result = collectScanCandidates(makeArgs());
    expect(result.candidates).toEqual([]);
    expect(result.unreachable).toEqual([]);
  });

  it("扫出的候选带 rel/size/hostPath，inModelsRoot 恒 true", () => {
    touch(modelsRoot, "main/m1.gguf", 100);

    const result = collectScanCandidates(makeArgs());

    expect(result.candidates).toHaveLength(1);
    const c = result.candidates[0]!;
    expect(c.rel).toBe("main/m1.gguf");
    expect(c.size).toBe(100);
    expect(c.inModelsRoot).toBe(true);
    expect(c.hostPath).toBe(fakeToHost(path.join(modelsRoot, "main/m1.gguf")));
  });

  it("fullSha256 取自调用方传入的缓存映射，未命中为 null——本模块自己绝不算哈希", () => {
    touch(modelsRoot, "main/m1.gguf", 100);
    touch(modelsRoot, "main/m2.gguf", 100);

    const result = collectScanCandidates(
      makeArgs({ fullSha256ByRel: new Map([["main/m1.gguf", "a".repeat(64)]]) }),
    );

    const byRel = new Map(result.candidates.map((c) => [c.rel, c.fullSha256]));
    expect(byRel.get("main/m1.gguf")).toBe("a".repeat(64));
    expect(byRel.get("main/m2.gguf")).toBeNull();
  });

  it("resolveOid 提供后其返回值即为终局，不退回 fullSha256ByRel（即便返回 null）", () => {
    touch(modelsRoot, "main/m1.gguf", 100);
    touch(modelsRoot, "main/m2.gguf", 100);

    const result = collectScanCandidates(
      makeArgs({
        // 与 resolveOid 对同一个 m1 给出的值刻意不同，用来判定谁赢
        fullSha256ByRel: new Map([
          ["main/m1.gguf", "b".repeat(64)],
          ["main/m2.gguf", "c".repeat(64)],
        ]),
        resolveOid: (rel) => (rel === "main/m1.gguf" ? "a".repeat(64) : null),
      }),
    );

    const byRel = new Map(result.candidates.map((c) => [c.rel, c.fullSha256]));
    // m1：resolveOid 给出 A、fullSha256ByRel 给出 B——取 A，resolveOid 优先
    expect(byRel.get("main/m1.gguf")).toBe("a".repeat(64));
    // m2：resolveOid 返回 null——这是终局，不退回 fullSha256ByRel 里未经校验的旧值
    expect(byRel.get("main/m2.gguf")).toBeNull();
  });

  it("resolveOid 提供时其返回值是终局：返回 null（新鲜度校验拒掉陈旧缓存）不会被 fullSha256ByRel 兜回来（复核修复 L-1）", () => {
    touch(modelsRoot, "main/m1.gguf", 100);

    const result = collectScanCandidates(
      makeArgs({
        // fullSha256ByRel 里仍留着陈旧值（模拟 file_meta 的一次性快照，没有经过
        // 任何新鲜度校验）；resolveOid 模拟 resolveLocalOid 的新鲜度校验判定
        // 磁盘现状与缓存对不上、拒掉陈旧缓存返回 null——这正是 K-2 修复要产生
        // 的效果，L-1 要保证这个 null 不被下面的兜底覆盖掉
        fullSha256ByRel: new Map([["main/m1.gguf", "b".repeat(64)]]),
        resolveOid: () => null,
      }),
    );

    const byRel = new Map(result.candidates.map((c) => [c.rel, c.fullSha256]));
    expect(byRel.get("main/m1.gguf")).toBeNull();
  });

  it("inRepoDir 按 repoDirOf 的目录边界语义判定，落在档案目录外为 null", () => {
    touch(modelsRoot, "hf/o/R/model.gguf", 100);
    touch(modelsRoot, "loose/other.gguf", 100);

    const result = collectScanCandidates(makeArgs({ repoDirs: ["hf/o/R"] }));

    const byRel = new Map(result.candidates.map((c) => [c.rel, c.inRepoDir]));
    expect(byRel.get("hf/o/R/model.gguf")).toBe("hf/o/R");
    expect(byRel.get("loose/other.gguf")).toBeNull();
  });

  it("候选带 referenced：引用集合命中的置 true，其余 false", () => {
    // 夹具在 models 根内造 loose/a.gguf 与 loose/b.gguf
    touch(modelsRoot, "loose/a.gguf", 10);
    touch(modelsRoot, "loose/b.gguf", 10);

    const { candidates } = collectScanCandidates(
      makeArgs({ referencedRels: new Set(["loose/a.gguf"]) }),
    );
    expect(candidates.find((c) => c.rel === "loose/a.gguf")?.referenced).toBe(true);
    expect(candidates.find((c) => c.rel === "loose/b.gguf")?.referenced).toBe(false);
  });

  it("unarchived 只含 models 根内、不属于任何档案的候选", () => {
    touch(modelsRoot, "hf/u/r/inside.gguf", 100);
    touch(modelsRoot, "loose/free.gguf", 50);

    const { unarchived } = collectScanCandidates(makeArgs({ repoDirs: ["hf/u/r"] }));
    expect(unarchived.every((c) => c.inModelsRoot && c.inRepoDir === null)).toBe(true);
    expect(unarchived.some((c) => c.rel === "hf/u/r/inside.gguf")).toBe(false);
    expect(unarchived.some((c) => c.rel === "loose/free.gguf")).toBe(true);
  });
});

describe("collectScanCandidates：自定义目录", () => {
  it("可达目录内的文件计入候选：rel/fullSha256/inRepoDir 恒为 null，inModelsRoot 恒 false", () => {
    touch(extraRoot, "old/model.gguf", 200);

    const result = collectScanCandidates(
      makeArgs({
        extraHostDirs: ["/host/old-models"],
        toPanel: () => extraRoot, // 唯一一个自定义目录，换算恒指向 extraRoot
      }),
    );

    expect(result.unreachable).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    const c = result.candidates[0]!;
    expect(c.rel).toBeNull();
    expect(c.fullSha256).toBeNull();
    expect(c.inRepoDir).toBeNull();
    expect(c.inModelsRoot).toBe(false);
    expect(c.size).toBe(200);
    expect(c.hostPath).toBe(fakeToHost(path.join(extraRoot, "old/model.gguf")));
  });

  it("models 根外的候选 referenced 恒为 false", () => {
    // 根外文件即便 rel 命中引用集合也不该生效——根外文件不可能被配置引用
    // （见 LocalCandidate.referenced 注释）。夹具在自定义目录内造一份文件，
    // 确保下面的 every() 不是空数组上的真空为真
    touch(extraRoot, "extra.gguf", 10);

    const { candidates } = collectScanCandidates(
      makeArgs({
        extraHostDirs: ["/host/extra"],
        toPanel: () => extraRoot,
        referencedRels: new Set(["extra.gguf"]),
      }),
    );
    const outside = candidates.filter((c) => !c.inModelsRoot);
    expect(outside).not.toEqual([]);
    expect(outside.every((c) => c.referenced === false)).toBe(true);
  });

  it("toPanel 换算失败（不在任何已知挂载映射内）——收进 unreachable，不算错误、不抛出", () => {
    const result = collectScanCandidates(
      makeArgs({
        extraHostDirs: ["/srv/unmapped"],
        toPanel: () => {
          throw new Error("路径在映射之外");
        },
      }),
    );

    expect(result.unreachable).toEqual(["/srv/unmapped"]);
    expect(result.candidates).toEqual([]);
  });

  it("换算成功但面板容器内路径不存在——同样收进 unreachable：面板是容器，看不见宿主机大部分路径是常态", () => {
    const missingPanelDir = path.join(extraRoot, "does-not-exist");

    const result = collectScanCandidates(
      makeArgs({
        extraHostDirs: ["/srv/not-mounted"],
        toPanel: () => missingPanelDir,
      }),
    );

    expect(result.unreachable).toEqual(["/srv/not-mounted"]);
    expect(result.candidates).toEqual([]);
  });

  it("多个自定义目录时可达与不可达各自独立收集，互不影响", () => {
    touch(extraRoot, "reachable.gguf", 50);
    const missingPanelDir = path.join(extraRoot, "ghost");

    const result = collectScanCandidates(
      makeArgs({
        extraHostDirs: ["/host/ok", "/host/missing", "/host/unmapped"],
        toPanel: (hostDir) => {
          if (hostDir === "/host/ok") return extraRoot;
          if (hostDir === "/host/missing") return missingPanelDir;
          throw new Error("unmapped");
        },
      }),
    );

    expect(result.unreachable.sort()).toEqual(["/host/missing", "/host/unmapped"]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.size).toBe(50);
  });
  // m1：自定义目录被填成一个**文件**时 existsSync 会通过，scanTree 随后 readdir
  // 抛 ENOTDIR，整个 scan 请求 500。一条填错的目录不该拖垮整次扫描
  it("自定义目录指向的是文件而不是目录——收进 unreachable，不抛 ENOTDIR", () => {
    touch(extraRoot, "not-a-dir.gguf", 20);
    const filePath = path.join(extraRoot, "not-a-dir.gguf");

    const result = collectScanCandidates(
      makeArgs({
        extraHostDirs: ["/host/file"],
        toPanel: () => filePath,
      }),
    );

    expect(result.unreachable).toEqual(["/host/file"]);
    expect(result.candidates).toEqual([]);
  });
});

// m6：与 lib/repo-files-scan.ts 的 isPartial 同一份后缀常量。半成品被当成候选，
// 用户就可能把一个还没写完的文件「移动」进档案目录，得到一份坏权重
describe("collectScanCandidates：半成品过滤", () => {
  it("models 根内的 .part / .part.meta.json 不进候选", () => {
    touch(modelsRoot, "main/m1.gguf", 100);
    touch(modelsRoot, "main/m2.gguf.part", 40);
    touch(modelsRoot, "main/m2.gguf.part.meta.json", 30);

    const result = collectScanCandidates(makeArgs());

    expect(result.candidates.map((c) => c.rel)).toEqual(["main/m1.gguf"]);
  });

  it("自定义目录内的半成品同样不进候选（两路口径一致）", () => {
    touch(extraRoot, "a.gguf", 10);
    touch(extraRoot, "b.gguf.part", 10);

    const result = collectScanCandidates(
      makeArgs({ extraHostDirs: ["/host/extra"], toPanel: () => extraRoot }),
    );

    expect(result.candidates.map((c) => c.absPath)).toEqual([path.join(extraRoot, "a.gguf")]);
  });
});
