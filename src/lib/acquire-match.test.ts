import { describe, expect, it } from "vitest";
import { actionsFor, matchLocalCandidate, mergeGroupMatch, type FileMatch, type LocalCandidate } from "./acquire-match";

const remote = { path: "Q4_K_M.gguf", size: 2600, oid: "a".repeat(64) };

function cand(over: Partial<LocalCandidate> = {}): LocalCandidate {
  return {
    absPath: "/host-models/loose/Q4_K_M.gguf",
    rel: "loose/Q4_K_M.gguf",
    size: 2600,
    fullSha256: null,
    inRepoDir: null,
    inModelsRoot: true,
    hostPath: "/mnt/data/models/loose/Q4_K_M.gguf",
    ...over,
  };
}

describe("matchLocalCandidate", () => {
  it("同名同大小命中", () => {
    expect(matchLocalCandidate(remote, [cand()])).not.toBeNull();
  });

  it("大小不同不命中——同名但下坏了的半成品不该被当成同一个文件", () => {
    expect(matchLocalCandidate(remote, [cand({ size: 999 })])).toBeNull();
  });

  it("改过名但缓存哈希等于远端 oid 时命中——跨仓库同一份文件的唯一判据", () => {
    const renamed = cand({
      absPath: "/host-models/hf/other/Model.Q4_K_M.gguf",
      rel: "hf/other/Model.Q4_K_M.gguf",
      fullSha256: "a".repeat(64),
    });
    expect(matchLocalCandidate(remote, [renamed])?.rel).toBe("hf/other/Model.Q4_K_M.gguf");
  });

  it("改过名且无缓存哈希时不命中——不能凭大小认领", () => {
    const renamed = cand({ absPath: "/host-models/x/Other.gguf", rel: "x/Other.gguf" });
    expect(matchLocalCandidate(remote, [renamed])).toBeNull();
  });

  it("远端 size 为 0 或缺失时一律不命中", () => {
    expect(matchLocalCandidate({ path: "a.gguf", size: 0 }, [cand({ size: 0 })])).toBeNull();
  });
});

describe("mergeGroupMatch", () => {
  const fm = (over: Partial<FileMatch> = {}): FileMatch => ({
    file: "m.gguf", candidate: cand(), actions: ["download", "move", "link"],
    defaultAction: "move", restriction: "none", ...over,
  });

  it("组内动作一致时组级取该动作", () => {
    const g = mergeGroupMatch("Q4_K_M", "model", [fm(), fm({ file: "m2.gguf" })]);
    expect(g.actions).toEqual(["download", "move", "link"]);
    expect(g.defaultAction).toBe("move");
  });

  it("组内一片没有本地副本时不拖累另一片——那片走下载，组级动作仍按已有的那片推出", () => {
    const g = mergeGroupMatch("Q4_K_M", "model", [
      fm(),
      fm({ file: "m2.gguf", candidate: null, actions: ["download"], defaultAction: "download" }),
    ]);
    expect(g.actions).toEqual(["download", "move", "link"]);
    expect(g.defaultAction).toBe("move");
  });

  it("组内一片都没有本地副本时只能下载", () => {
    const g = mergeGroupMatch("Q4_K_M", "model", [
      fm({ candidate: null, actions: ["download"], defaultAction: "download" }),
      fm({ file: "m2.gguf", candidate: null, actions: ["download"], defaultAction: "download" }),
    ]);
    expect(g.actions).toEqual(["download"]);
    expect(g.defaultAction).toBe("download");
  });

  it("组内一片在别的档案、一片游离：交集只剩 link", () => {
    const g = mergeGroupMatch("Q4_K_M", "model", [
      fm(),
      fm({ file: "m2.gguf", actions: ["download", "link"], defaultAction: "link", restriction: "in-repo" }),
    ]);
    expect(g.actions).toEqual(["download", "link"]);
    expect(g.defaultAction).toBe("link");
    expect(g.restriction).toBe("in-repo");
  });
});

describe("actionsFor", () => {
  it("models 内非档案目录：可移动可链接，默认移动", () => {
    const r = actionsFor(remote, cand());
    expect(r.actions).toEqual(["download", "move", "link"]);
    expect(r.defaultAction).toBe("move");
    expect(r.restriction).toBe("none");
  });

  it("在另一个档案目录内：禁用移动，默认链接", () => {
    const r = actionsFor(remote, cand({ inRepoDir: "hf/other/Repo" }));
    expect(r.actions).toEqual(["download", "link"]);
    expect(r.defaultAction).toBe("link");
    expect(r.restriction).toBe("in-repo");
  });

  it("models 外：可复制可移动（移动=复制后删源），禁用链接，默认复制", () => {
    const r = actionsFor(remote, cand({ rel: null, inModelsRoot: false, absPath: "/host-import/a.gguf" }));
    expect(r.actions).toEqual(["download", "copy", "move"]);
    expect(r.defaultAction).toBe("copy");
    expect(r.restriction).toBe("outside-root");
  });

  it("远端无 oid：只能下载——没有内容哈希可比对，不许凭名字挪", () => {
    const r = actionsFor({ path: "README.md", size: 100 }, cand());
    expect(r.actions).toEqual(["download"]);
    expect(r.defaultAction).toBe("download");
    expect(r.restriction).toBe("no-oid");
  });

  it("无候选：只能下载", () => {
    const r = actionsFor(remote, null);
    expect(r.actions).toEqual(["download"]);
    expect(r.defaultAction).toBe("download");
  });
});
