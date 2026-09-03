import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectScanCandidates } from "./scanCandidates";

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

describe("collectScanCandidates：models 根", () => {
  it("空 models 树返回空候选、无 unreachable", () => {
    const result = collectScanCandidates({
      modelsRoot,
      extraHostDirs: [],
      repoDirs: [],
      fullSha256ByRel: new Map(),
      toHost: fakeToHost,
      toPanel: (p) => p,
    });
    expect(result.candidates).toEqual([]);
    expect(result.unreachable).toEqual([]);
  });

  it("扫出的候选带 rel/size/hostPath，inModelsRoot 恒 true", () => {
    touch(modelsRoot, "main/m1.gguf", 100);

    const result = collectScanCandidates({
      modelsRoot,
      extraHostDirs: [],
      repoDirs: [],
      fullSha256ByRel: new Map(),
      toHost: fakeToHost,
      toPanel: (p) => p,
    });

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

    const result = collectScanCandidates({
      modelsRoot,
      extraHostDirs: [],
      repoDirs: [],
      fullSha256ByRel: new Map([["main/m1.gguf", "a".repeat(64)]]),
      toHost: fakeToHost,
      toPanel: (p) => p,
    });

    const byRel = new Map(result.candidates.map((c) => [c.rel, c.fullSha256]));
    expect(byRel.get("main/m1.gguf")).toBe("a".repeat(64));
    expect(byRel.get("main/m2.gguf")).toBeNull();
  });

  it("inRepoDir 按 repoDirOf 的目录边界语义判定，落在档案目录外为 null", () => {
    touch(modelsRoot, "hf/o/R/model.gguf", 100);
    touch(modelsRoot, "loose/other.gguf", 100);

    const result = collectScanCandidates({
      modelsRoot,
      extraHostDirs: [],
      repoDirs: ["hf/o/R"],
      fullSha256ByRel: new Map(),
      toHost: fakeToHost,
      toPanel: (p) => p,
    });

    const byRel = new Map(result.candidates.map((c) => [c.rel, c.inRepoDir]));
    expect(byRel.get("hf/o/R/model.gguf")).toBe("hf/o/R");
    expect(byRel.get("loose/other.gguf")).toBeNull();
  });
});

describe("collectScanCandidates：自定义目录", () => {
  it("可达目录内的文件计入候选：rel/fullSha256/inRepoDir 恒为 null，inModelsRoot 恒 false", () => {
    touch(extraRoot, "old/model.gguf", 200);

    const result = collectScanCandidates({
      modelsRoot,
      extraHostDirs: ["/host/old-models"],
      repoDirs: [],
      fullSha256ByRel: new Map(),
      toHost: fakeToHost,
      toPanel: () => extraRoot, // 唯一一个自定义目录，换算恒指向 extraRoot
    });

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

  it("toPanel 换算失败（不在任何已知挂载映射内）——收进 unreachable，不算错误、不抛出", () => {
    const result = collectScanCandidates({
      modelsRoot,
      extraHostDirs: ["/srv/unmapped"],
      repoDirs: [],
      fullSha256ByRel: new Map(),
      toHost: fakeToHost,
      toPanel: () => {
        throw new Error("路径在映射之外");
      },
    });

    expect(result.unreachable).toEqual(["/srv/unmapped"]);
    expect(result.candidates).toEqual([]);
  });

  it("换算成功但面板容器内路径不存在——同样收进 unreachable：面板是容器，看不见宿主机大部分路径是常态", () => {
    const missingPanelDir = path.join(extraRoot, "does-not-exist");

    const result = collectScanCandidates({
      modelsRoot,
      extraHostDirs: ["/srv/not-mounted"],
      repoDirs: [],
      fullSha256ByRel: new Map(),
      toHost: fakeToHost,
      toPanel: () => missingPanelDir,
    });

    expect(result.unreachable).toEqual(["/srv/not-mounted"]);
    expect(result.candidates).toEqual([]);
  });

  it("多个自定义目录时可达与不可达各自独立收集，互不影响", () => {
    touch(extraRoot, "reachable.gguf", 50);
    const missingPanelDir = path.join(extraRoot, "ghost");

    const result = collectScanCandidates({
      modelsRoot,
      extraHostDirs: ["/host/ok", "/host/missing", "/host/unmapped"],
      repoDirs: [],
      fullSha256ByRel: new Map(),
      toHost: fakeToHost,
      toPanel: (hostDir) => {
        if (hostDir === "/host/ok") return extraRoot;
        if (hostDir === "/host/missing") return missingPanelDir;
        throw new Error("unmapped");
      },
    });

    expect(result.unreachable.sort()).toEqual(["/host/missing", "/host/unmapped"]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.size).toBe(50);
  });
});
