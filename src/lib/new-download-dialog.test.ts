import { describe, expect, it } from "vitest";

import {
  DEFAULT_REPO_BASE_DIR,
  initialUrlTargetDir,
  isValidDownloadUrl,
  normalizeFilename,
  repoBaseDirOptions,
  repoSubmitDisabled,
  resolveRepoProbeDisplay,
  urlSubmitDisabled,
} from "./new-download-dialog";

describe("repoBaseDirOptions", () => {
  it("folders 不含 hf 时补在最前面，再补根目录", () => {
    expect(repoBaseDirOptions(["main", "vision"])).toEqual(["", "hf", "main", "vision"]);
  });

  it("folders 已含 hf 时不重复添加", () => {
    expect(repoBaseDirOptions(["hf", "main"])).toEqual(["", "hf", "main"]);
  });

  it("空列表兜底为根目录 + hf 两项", () => {
    expect(repoBaseDirOptions([])).toEqual(["", "hf"]);
  });

  it("不修改入参数组", () => {
    const input = ["main"];
    repoBaseDirOptions(input);
    expect(input).toEqual(["main"]);
  });
});

describe("resolveRepoProbeDisplay", () => {
  const baseParams = { baseDir: "hf", phase: "idle" as const, result: null, probedRepo: null };

  it("repo 为空串（或全空白）→ empty", () => {
    expect(resolveRepoProbeDisplay({ ...baseParams, repo: "" })).toEqual({ kind: "empty" });
    expect(resolveRepoProbeDisplay({ ...baseParams, repo: "   " })).toEqual({ kind: "empty" });
  });

  it("repo 格式非法 → invalid，优先于探测状态", () => {
    expect(
      resolveRepoProbeDisplay({ ...baseParams, repo: "/bad", phase: "loading" }),
    ).toEqual({ kind: "invalid" });
  });

  it("探测请求进行中 → loading", () => {
    expect(resolveRepoProbeDisplay({ ...baseParams, repo: "owner/repo", phase: "loading" })).toEqual({
      kind: "loading",
    });
  });

  it("探测请求失败且失败对象是当前 repo → error", () => {
    expect(
      resolveRepoProbeDisplay({
        ...baseParams,
        repo: "owner/repo",
        phase: "error",
        probedRepo: "owner/repo",
      }),
    ).toEqual({ kind: "error" });
  });

  it("探测失败但 repo 已经改过（不匹配 probedRepo）→ 视为尚未探测，clear", () => {
    expect(
      resolveRepoProbeDisplay({
        ...baseParams,
        repo: "owner/other",
        phase: "error",
        probedRepo: "owner/repo",
      }),
    ).toEqual({ kind: "clear" });
  });

  it("尚未发起过探测（result 为 null）→ clear，不阻断提交", () => {
    expect(resolveRepoProbeDisplay({ ...baseParams, repo: "owner/repo" })).toEqual({ kind: "clear" });
  });

  it("探测结果属于旧 repo（probedRepo 不匹配）→ clear，不误用陈旧结果", () => {
    expect(
      resolveRepoProbeDisplay({
        ...baseParams,
        repo: "owner/new-repo",
        probedRepo: "owner/old-repo",
        result: { existing: [{ id: 1, targetDir: "hf/owner/new-repo" }], orphans: [] },
      }),
    ).toEqual({ kind: "clear" });
  });

  it("命中已有档案，且 targetDir 与当前选中 baseDir 拼出的路径一致 → exists", () => {
    expect(
      resolveRepoProbeDisplay({
        ...baseParams,
        repo: "owner/repo",
        probedRepo: "owner/repo",
        result: { existing: [{ id: 7, targetDir: "hf/owner/repo" }], orphans: [] },
      }),
    ).toEqual({ kind: "exists", targetDir: "hf/owner/repo", id: 7 });
  });

  it("已有档案存在，但挂在别的 baseDir 下（targetDir 对不上当前选择）→ 不算 exists", () => {
    expect(
      resolveRepoProbeDisplay({
        ...baseParams,
        repo: "owner/repo",
        baseDir: "other",
        probedRepo: "owner/repo",
        result: { existing: [{ id: 7, targetDir: "hf/owner/repo" }], orphans: [] },
      }),
    ).toEqual({ kind: "clear" });
  });

  it("命中孤儿目录（带标记文件但未登记）→ orphan", () => {
    expect(
      resolveRepoProbeDisplay({
        ...baseParams,
        repo: "owner/repo",
        probedRepo: "owner/repo",
        result: { existing: [], orphans: ["hf/owner/repo"] },
      }),
    ).toEqual({ kind: "orphan", targetDir: "hf/owner/repo" });
  });

  it("既非已有档案也非孤儿 → clear", () => {
    expect(
      resolveRepoProbeDisplay({
        ...baseParams,
        repo: "owner/repo",
        probedRepo: "owner/repo",
        result: { existing: [], orphans: [] },
      }),
    ).toEqual({ kind: "clear" });
  });

  it("baseDir 为根目录（空串）时也能正确拼出 targetDir 命中已有档案", () => {
    expect(
      resolveRepoProbeDisplay({
        ...baseParams,
        repo: "owner/repo",
        baseDir: "",
        probedRepo: "owner/repo",
        result: { existing: [{ id: 3, targetDir: "owner/repo" }], orphans: [] },
      }),
    ).toEqual({ kind: "exists", targetDir: "owner/repo", id: 3 });
  });
});

describe("repoSubmitDisabled", () => {
  it("busy 时始终禁用，不管探测状态", () => {
    expect(repoSubmitDisabled({ kind: "clear" }, "hf", true)).toBe(true);
  });

  it("repo 为空 / 格式非法 / 探测中 → 禁用", () => {
    expect(repoSubmitDisabled({ kind: "empty" }, "hf", false)).toBe(true);
    expect(repoSubmitDisabled({ kind: "invalid" }, "hf", false)).toBe(true);
    expect(repoSubmitDisabled({ kind: "loading" }, "hf", false)).toBe(true);
  });

  it("命中已有档案 → 禁用", () => {
    expect(repoSubmitDisabled({ kind: "exists", targetDir: "hf/a/b", id: 1 }, "hf", false)).toBe(true);
  });

  it("孤儿 / 探测失败 / 尚未探测 → 允许提交（服务端兜底最终校验）", () => {
    expect(repoSubmitDisabled({ kind: "orphan", targetDir: "hf/a/b" }, "hf", false)).toBe(false);
    expect(repoSubmitDisabled({ kind: "error" }, "hf", false)).toBe(false);
    expect(repoSubmitDisabled({ kind: "clear" }, "hf", false)).toBe(false);
  });

  it("baseDir 格式非法（如带前导斜杠）→ 禁用", () => {
    expect(repoSubmitDisabled({ kind: "clear" }, "/bad", false)).toBe(true);
  });
});

describe("isValidDownloadUrl", () => {
  it("接受 http/https 链接", () => {
    expect(isValidDownloadUrl("https://example.com/a.gguf")).toBe(true);
    expect(isValidDownloadUrl("http://example.com/a.gguf")).toBe(true);
  });

  it("拒绝空串与纯空白", () => {
    expect(isValidDownloadUrl("")).toBe(false);
    expect(isValidDownloadUrl("   ")).toBe(false);
  });

  it("拒绝非 http(s) 协议", () => {
    expect(isValidDownloadUrl("ftp://example.com/a.gguf")).toBe(false);
    expect(isValidDownloadUrl("file:///etc/passwd")).toBe(false);
  });

  it("拒绝无法解析的字符串", () => {
    expect(isValidDownloadUrl("not a url")).toBe(false);
  });

  it("首尾空白不影响判定", () => {
    expect(isValidDownloadUrl("  https://example.com/a.gguf  ")).toBe(true);
  });
});

describe("normalizeFilename", () => {
  it("空串或纯空白 → undefined（交给服务端从 URL 派生）", () => {
    expect(normalizeFilename("")).toBeUndefined();
    expect(normalizeFilename("   ")).toBeUndefined();
  });

  it("有内容时去除首尾空白后返回", () => {
    expect(normalizeFilename("  model.gguf  ")).toBe("model.gguf");
  });
});

describe("urlSubmitDisabled", () => {
  it("busy 时禁用", () => {
    expect(urlSubmitDisabled("https://example.com/a.gguf", "main", [], true)).toBe(true);
  });

  it("URL 不合法时禁用", () => {
    expect(urlSubmitDisabled("not a url", "main", [], false)).toBe(true);
  });

  it("目标目录落在某个档案目录内时禁用", () => {
    expect(urlSubmitDisabled("https://example.com/a.gguf", "hf/owner/repo", ["hf/owner/repo"], false)).toBe(
      true,
    );
  });

  it("目标目录是档案目录的子路径时同样禁用（按目录边界判定）", () => {
    expect(
      urlSubmitDisabled("https://example.com/a.gguf", "hf/owner/repo/sub", ["hf/owner/repo"], false),
    ).toBe(true);
  });

  it("目标目录前缀相似但不是同一目录时放行（不是裸 startsWith）", () => {
    expect(
      urlSubmitDisabled("https://example.com/a.gguf", "hf/owner/repo-extra", ["hf/owner/repo"], false),
    ).toBe(false);
  });

  it("一切合法时允许提交", () => {
    expect(urlSubmitDisabled("https://example.com/a.gguf", "main", ["hf/owner/repo"], false)).toBe(false);
  });
});

describe("initialUrlTargetDir", () => {
  it("提供 defaultBaseDir 时直接采纳，即使不在 folders 列表里", () => {
    expect(initialUrlTargetDir("qwen3.6/70b", ["main"])).toBe("qwen3.6/70b");
  });

  it("defaultBaseDir 为空串（根目录）也直接采纳，不落回默认目录", () => {
    expect(initialUrlTargetDir("", ["main"])).toBe("");
  });

  it("未提供 defaultBaseDir 时落回 pickDefaultFolder 的选择", () => {
    expect(initialUrlTargetDir(undefined, ["lab", "main"])).toBe("main");
    expect(initialUrlTargetDir(undefined, ["lab"])).toBe("lab");
    expect(initialUrlTargetDir(undefined, [])).toBe("");
  });
});

describe("DEFAULT_REPO_BASE_DIR", () => {
  it("默认存放位置固定为 hf", () => {
    expect(DEFAULT_REPO_BASE_DIR).toBe("hf");
  });
});
