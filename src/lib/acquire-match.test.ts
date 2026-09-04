import { describe, expect, it } from "vitest";
import {
  actionsFor,
  matchLocalCandidate,
  pairsWithRemote,
  mergeGroupMatch,
  toDownloadFile,
  type CandidateFacts,
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

function makeFacts(over: Partial<CandidateFacts> = {}): CandidateFacts {
  return { inRepoDir: null, inModelsRoot: true, drift: "same", referenced: false, ...over };
}

/**
 * pairsWithRemote：配对判据的唯一定义。matchLocalCandidate（从一堆候选里挑）
 * 与服务端第二道重验（server/acquireGuard.assertRemoteMatch，验一个指定的源）
 * 共用它——两处各写一份会出现「扫描给得出、提交却被拒」的自相矛盾。
 */
describe("pairsWithRemote", () => {
  it("同名即成对（远端路径带目录，只比 basename）", () => {
    expect(pairsWithRemote(remote, { basename: "Q4_K_M.gguf", fullSha256: null })).toBe(true);
    expect(
      pairsWithRemote({ path: "sub/dir/Q4_K_M.gguf", size: 1, oid: OID_A }, {
        basename: "Q4_K_M.gguf",
        fullSha256: null,
      }),
    ).toBe(true);
  });

  it("名字不同但本地哈希等于远端 oid 也成对——跨仓库同一份文件的唯一判据", () => {
    expect(pairsWithRemote(remote, { basename: "改过名.gguf", fullSha256: OID_A })).toBe(true);
  });

  it("名字不同且哈希不命中：不成对", () => {
    expect(pairsWithRemote(remote, { basename: "改过名.gguf", fullSha256: "b".repeat(64) })).toBe(false);
    expect(pairsWithRemote(remote, { basename: "改过名.gguf", fullSha256: null })).toBe(false);
  });

  it("远端 oid 格式非法时不能凭哈希认领（非 LFS 文件的 oid 可能是别的算法）", () => {
    expect(
      pairsWithRemote({ path: "Q4_K_M.gguf", size: 2600, oid: "deadbeef" }, {
        basename: "改过名.gguf",
        fullSha256: "deadbeef",
      }),
    ).toBe(false);
  });

  // size 属于「判定」不属于「配对」（规格 §4.0）：同名但大小不同照样成对，
  // 只是 drift 判成 different——旧实现在这里 continue，于是「本机有同名文件但
  // 版本不同」在界面上完全沉默
  it("大小不参与配对", () => {
    expect(pairsWithRemote(remote, { basename: "Q4_K_M.gguf", fullSha256: null })).toBe(true);
  });
});

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
    const r = actionsFor(remote, makeFacts());
    expect(r.actions).toEqual(["download", "move", "link"]);
    expect(r.defaultAction).toBe("move");
    expect(r.restriction).toBe("none");
  });

  it("在另一个档案目录内：禁用移动，默认链接", () => {
    const r = actionsFor(remote, makeFacts({ inRepoDir: "hf/other/Repo" }));
    expect(r.actions).toEqual(["download", "link"]);
    expect(r.defaultAction).toBe("link");
    expect(r.restriction).toBe("in-repo");
  });

  // m3：动作顺序与组级交集（mergeGroupMatch）共用同一份 ACTION_ORDER——此前
  // 这里是 copy 在前、组级是 move 在前，同一场景下单文件组与多分片组的下拉
  // 顺序会不一致。defaultAction 不跟着变，仍是 copy
  it("models 外：可复制可移动（移动=复制后删源），禁用链接，默认复制，顺序与组级一致", () => {
    const r = actionsFor(remote, makeFacts({ inModelsRoot: false }));
    expect(r.actions).toEqual(["download", "move", "copy"]);
    expect(r.defaultAction).toBe("copy");
    expect(r.restriction).toBe("outside-root");
  });

  it("单文件组与多文件组在 models 外场景给出同一个动作顺序", () => {
    const outside = makeCandidate({ rel: null, inModelsRoot: false, absPath: "/host-import/a.gguf" });
    const facts = makeFacts({ inModelsRoot: false });
    const file = { file: "a.gguf", candidate: outside, drift: "same" as const, ...actionsFor(remote, facts) };
    expect(mergeGroupMatch("Q4_K_M", "model", [file, { ...file, file: "b.gguf" }]).actions).toEqual(
      actionsFor(remote, facts).actions,
    );
  });

  it("远端无 oid：只能下载——没有内容哈希可比对，不许凭名字挪", () => {
    const r = actionsFor({ path: "README.md", size: 100 }, makeFacts());
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

describe("actionsFor · 被配置引用维与版本漂移", () => {
  const remote = { path: "a.gguf", size: 100, oid: OID_A };
  const loose = { inRepoDir: null, inModelsRoot: true };

  it("未被引用的未归档文件：默认移动（现状不变）", () => {
    const r = actionsFor(remote, { ...loose, drift: "same", referenced: false });
    expect(r.actions).toEqual(["download", "move", "link"]);
    expect(r.defaultAction).toBe("move");
  });

  it("被配置引用：裸 move 消失、补入 move-with-refs、默认降为 link", () => {
    const r = actionsFor(remote, { ...loose, drift: "same", referenced: true });
    expect(r.actions).toEqual(["download", "move-with-refs", "link"]);
    expect(r.defaultAction).toBe("link");
  });

  it("move-with-refs 永远不做默认动作（它是显式的 opt-in）", () => {
    const r = actionsFor(remote, { ...loose, drift: "unknown", referenced: true });
    expect(r.defaultAction).not.toBe("move-with-refs");
  });

  it("在别的档案目录内：引用与否都只有 download/link", () => {
    const inRepo = { inRepoDir: "hf/u/r", inModelsRoot: true };
    for (const referenced of [true, false]) {
      const r = actionsFor(remote, { ...inRepo, drift: "same", referenced });
      expect(r.actions).toEqual(["download", "link"]);
      expect(r.restriction).toBe("in-repo");
    }
  });

  it("models 根外：不受 referenced 影响", () => {
    const outside = { inRepoDir: null, inModelsRoot: false };
    const r = actionsFor(remote, { ...outside, drift: "same", referenced: false });
    expect(r.actions).toEqual(["download", "move", "copy"]);
    expect(r.defaultAction).toBe("copy");
    expect(r.restriction).toBe("outside-root");
  });

  it("drift 为 different：只能下载，限制码 version-drift（优先级高于位置）", () => {
    const r = actionsFor(remote, { ...loose, drift: "different", referenced: false });
    expect(r.actions).toEqual(["download"]);
    expect(r.restriction).toBe("version-drift");
  });

  it("远端无 oid 时仍是 no-oid，不被 version-drift 顶掉", () => {
    const r = actionsFor({ path: "a.gguf", size: 100 }, { ...loose, drift: "unknown", referenced: false });
    expect(r.actions).toEqual(["download"]);
    expect(r.restriction).toBe("no-oid");
  });

  // compareToRemote 在 size 不符时无论 oid 存不存在都给 different（version-drift.ts），
  // 所以「远端无 oid」在现实里完全可能与 drift:"different" 同时发生——上一条用例的
  // drift:"unknown" 覆盖不到这个真实冲突组合，必须单独钉住优先级
  it("远端无 oid 且本地候选 drift 为 different（真实冲突数据）时仍是 no-oid，不被 version-drift 顶掉", () => {
    const r = actionsFor({ path: "a.gguf", size: 100 }, { ...loose, drift: "different", referenced: false });
    expect(r.actions).toEqual(["download"]);
    expect(r.restriction).toBe("no-oid");
  });

  it("候选为 null：只能下载，限制码 none", () => {
    const r = actionsFor(remote, null);
    expect(r.actions).toEqual(["download"]);
    expect(r.restriction).toBe("none");
  });
});

describe("mergeGroupMatch · 新动作参与交集", () => {
  it("组内两片都被引用 → 组级给 move-with-refs，默认 link", () => {
    const facts = { inRepoDir: null, inModelsRoot: true, drift: "same" as const, referenced: true };
    const f = (file: string) => ({
      file,
      candidate: makeCandidate({ absPath: `/m/loose/${file}`, rel: `loose/${file}`, size: 100 }),
      drift: "same" as const,
      ...actionsFor({ path: file, size: 100, oid: OID_A }, facts),
    });
    const g = mergeGroupMatch("Q4_K_M", "model", [f("a-1.gguf"), f("a-2.gguf")]);
    expect(g.actions).toEqual(["download", "move-with-refs", "link"]);
    expect(g.defaultAction).toBe("link");
  });

  it("一片被引用一片没有 → 交集里没有 move 也没有 move-with-refs，默认 link", () => {
    const mk = (file: string, referenced: boolean) => ({
      file,
      candidate: makeCandidate({ absPath: `/m/loose/${file}`, rel: `loose/${file}`, size: 100 }),
      drift: "same" as const,
      ...actionsFor(
        { path: file, size: 100, oid: OID_A },
        { inRepoDir: null, inModelsRoot: true, drift: "same", referenced },
      ),
    });
    const g = mergeGroupMatch("Q4_K_M", "model", [mk("a-1.gguf", true), mk("a-2.gguf", false)]);
    expect(g.actions).toEqual(["download", "link"]);
    expect(g.defaultAction).toBe("link");
  });

  // mergeGroupMatch 改用共享 DEFAULT_PREFERENCE 后，全组都在 models 根外时组级
  // 默认动作从旧的本地 preference（move 排 copy 前）变成 copy——与文件级 actionsFor
  // 的 outside-root 分支收敛一致，但此前没有任何组级用例钉住这个组合
  it("组内文件全部在 models 根外时，组级默认动作是 copy（与文件级一致，不是 move）", () => {
    const facts = { inRepoDir: null, inModelsRoot: false, drift: "same" as const, referenced: false };
    const f = (file: string) => ({
      file,
      candidate: makeCandidate({ inModelsRoot: false, rel: null, absPath: `/host-import/${file}`, size: 100 }),
      drift: "same" as const,
      ...actionsFor({ path: file, size: 100, oid: OID_A }, facts),
    });
    const g = mergeGroupMatch("Q4_K_M", "model", [f("a-1.gguf"), f("a-2.gguf")]);
    expect(g.actions).toEqual(["download", "move", "copy"]);
    expect(g.defaultAction).toBe("copy");
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
