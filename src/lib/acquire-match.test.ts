import { describe, expect, it } from "vitest";
import {
  actionsFor,
  matchLocalCandidate,
  mergeGroupMatch,
  toDownloadFile,
  type FileMatch,
  type LocalCandidate,
} from "./acquire-match";

const OID_A = "a".repeat(64);
const remote = { path: "Q4_K_M.gguf", size: 2600, oid: OID_A };

function makeCandidate(over: Partial<LocalCandidate> = {}): LocalCandidate {
  return {
    absPath: "/host-models/loose/Q4_K_M.gguf",
    rel: "loose/Q4_K_M.gguf",
    size: 2600,
    fullSha256: null,
    inRepoDir: null,
    inModelsRoot: true,
    hostPath: "/mnt/data/models/loose/Q4_K_M.gguf",
    referenced: false,
    ...over,
  };
}

describe("matchLocalCandidate", () => {
  it("同名同大小命中", () => {
    expect(matchLocalCandidate(remote, [makeCandidate()])).not.toBeNull();
  });

  it("大小不同——仍然配对上，drift 反映版本不同", () => {
    const hit = matchLocalCandidate(remote, [makeCandidate({ size: 999 })]);
    expect(hit).not.toBeNull();
    expect(hit?.drift).toBe("different");
  });

  it("改过名但缓存哈希等于远端 oid 时命中——跨仓库同一份文件的唯一判据", () => {
    const renamed = makeCandidate({
      absPath: "/host-models/hf/other/Model.Q4_K_M.gguf",
      rel: "hf/other/Model.Q4_K_M.gguf",
      fullSha256: OID_A,
    });
    expect(matchLocalCandidate(remote, [renamed])?.candidate.rel).toBe("hf/other/Model.Q4_K_M.gguf");
  });

  it("改过名且无缓存哈希时不命中——不能凭大小认领", () => {
    const renamed = makeCandidate({ absPath: "/host-models/x/Other.gguf", rel: "x/Other.gguf" });
    expect(matchLocalCandidate(remote, [renamed])).toBeNull();
  });

  it("远端 size 为 0 或缺失时一律不命中", () => {
    expect(matchLocalCandidate({ path: "a.gguf", size: 0 }, [makeCandidate({ size: 0 })])).toBeNull();
  });

  it("同名但大小不符 → 仍然配对上，drift 为 different（不再沉默）", () => {
    const remote = { path: "a.gguf", size: 100, oid: OID_A };
    const cand = makeCandidate({ absPath: "/m/loose/a.gguf", rel: "loose/a.gguf", size: 200 });
    const hit = matchLocalCandidate(remote, [cand]);
    expect(hit?.candidate.rel).toBe("loose/a.gguf");
    expect(hit?.drift).toBe("different");
  });

  it("同名候选多个时按 same > unknown > different 取最优，而非先到先得", () => {
    const remote = { path: "a.gguf", size: 100, oid: OID_A };
    const wrongSize = makeCandidate({ absPath: "/m/x/a.gguf", rel: "x/a.gguf", size: 999 });
    const noOid = makeCandidate({ absPath: "/m/y/a.gguf", rel: "y/a.gguf", size: 100 });
    const exact = makeCandidate({
      absPath: "/m/z/a.gguf",
      rel: "z/a.gguf",
      size: 100,
      fullSha256: OID_A,
    });
    // 故意把最差的排在最前
    const hit = matchLocalCandidate(remote, [wrongSize, noOid, exact]);
    expect(hit?.candidate.rel).toBe("z/a.gguf");
    expect(hit?.drift).toBe("same");
  });

  it("同状态取先遇到的（稳定，不随数组顺序抖动语义）", () => {
    const remote = { path: "a.gguf", size: 100, oid: OID_A };
    const first = makeCandidate({ absPath: "/m/p/a.gguf", rel: "p/a.gguf", size: 100 });
    const second = makeCandidate({ absPath: "/m/q/a.gguf", rel: "q/a.gguf", size: 100 });
    expect(matchLocalCandidate(remote, [first, second])?.candidate.rel).toBe("p/a.gguf");
  });

  it("名字不同但本地 fullSha256 命中远端 oid → 配对上且 same", () => {
    const remote = { path: "a.gguf", size: 100, oid: OID_A };
    const renamed = makeCandidate({
      absPath: "/m/loose/renamed.gguf",
      rel: "loose/renamed.gguf",
      size: 100,
      fullSha256: OID_A,
    });
    const hit = matchLocalCandidate(remote, [renamed]);
    expect(hit?.candidate.rel).toBe("loose/renamed.gguf");
    expect(hit?.drift).toBe("same");
  });

  it("名字不同且哈希不命中 → 配对不上", () => {
    const remote = { path: "a.gguf", size: 100, oid: OID_A };
    const other = makeCandidate({ absPath: "/m/loose/b.gguf", rel: "loose/b.gguf", size: 100 });
    expect(matchLocalCandidate(remote, [other])).toBeNull();
  });
});

describe("mergeGroupMatch", () => {
  const fm = (over: Partial<FileMatch> = {}): FileMatch => ({
    file: "m.gguf", candidate: makeCandidate(), drift: "same", actions: ["download", "move", "link"],
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
      fm({ file: "m2.gguf", candidate: null, drift: null, actions: ["download"], defaultAction: "download" }),
    ]);
    expect(g.actions).toEqual(["download", "move", "link"]);
    expect(g.defaultAction).toBe("move");
  });

  it("组内一片都没有本地副本时只能下载", () => {
    const g = mergeGroupMatch("Q4_K_M", "model", [
      fm({ candidate: null, drift: null, actions: ["download"], defaultAction: "download" }),
      fm({ file: "m2.gguf", candidate: null, drift: null, actions: ["download"], defaultAction: "download" }),
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
    const r = actionsFor(remote, makeCandidate());
    expect(r.actions).toEqual(["download", "move", "link"]);
    expect(r.defaultAction).toBe("move");
    expect(r.restriction).toBe("none");
  });

  it("在另一个档案目录内：禁用移动，默认链接", () => {
    const r = actionsFor(remote, makeCandidate({ inRepoDir: "hf/other/Repo" }));
    expect(r.actions).toEqual(["download", "link"]);
    expect(r.defaultAction).toBe("link");
    expect(r.restriction).toBe("in-repo");
  });

  // m3：动作顺序与组级交集（mergeGroupMatch）共用同一份 ACTION_ORDER——此前
  // 这里是 copy 在前、组级是 move 在前，同一场景下单文件组与多分片组的下拉
  // 顺序会不一致。defaultAction 不跟着变，仍是 copy
  it("models 外：可复制可移动（移动=复制后删源），禁用链接，默认复制，顺序与组级一致", () => {
    const r = actionsFor(remote, makeCandidate({ rel: null, inModelsRoot: false, absPath: "/host-import/a.gguf" }));
    expect(r.actions).toEqual(["download", "move", "copy"]);
    expect(r.defaultAction).toBe("copy");
    expect(r.restriction).toBe("outside-root");
  });

  it("单文件组与多文件组在 models 外场景给出同一个动作顺序", () => {
    const outside = makeCandidate({ rel: null, inModelsRoot: false, absPath: "/host-import/a.gguf" });
    const file = { file: "a.gguf", candidate: outside, drift: "same" as const, ...actionsFor(remote, outside) };
    expect(mergeGroupMatch("Q4_K_M", "model", [file, { ...file, file: "b.gguf" }]).actions).toEqual(
      actionsFor(remote, outside).actions,
    );
  });

  it("远端无 oid：只能下载——没有内容哈希可比对，不许凭名字挪", () => {
    const r = actionsFor({ path: "README.md", size: 100 }, makeCandidate());
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

describe("toDownloadFile", () => {
  it("带合法 oid：转出 file/size/sha256", () => {
    expect(toDownloadFile(remote)).toEqual({ file: "Q4_K_M.gguf", size: 2600, sha256: "a".repeat(64) });
  });

  it("无 oid：省略 sha256 字段（不是 undefined 占位，键本身不存在）", () => {
    const f = toDownloadFile({ path: "README.md", size: 100 });
    expect(f).toEqual({ file: "README.md", size: 100 });
    expect("sha256" in f).toBe(false);
  });

  it("oid 不是合法 sha256 格式：同样省略 sha256——非 LFS 文件的 oid 可能是别的哈希算法", () => {
    const f = toDownloadFile({ path: "a.gguf", size: 10, oid: "not-a-real-sha256" });
    expect(f).toEqual({ file: "a.gguf", size: 10 });
  });
});
