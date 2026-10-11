import { describe, expect, it } from "vitest";
import type { UpstreamView } from "./upstream-types";
import { aliasConflictRow, aliasProblems, apiKeyDraftInvalid, buildCreateBody, buildTestBody, buildUpdateBody, draftFromView, draftProblem, emptyDraft, fieldProblems, type DraftField } from "./upstream-form";

const view: UpstreamView = {
  name: "strata",
  displayName: "Strata",
  baseUrl: "http://up:8080",
  hasApiKey: true,
  apiKeyTail: "9f3a",
  upstreamModel: "qwen-real",
  enabled: true,
  note: "V100",
  state: "reachable",
  lastCheckedAt: null,
  lastError: null,
  isDefault: false,
  aliases: [{ alias: "gpt-4.1", upstreamModel: "qwen-x" }, { alias: "plain", upstreamModel: null }],
  createdAt: "2026-10-11T00:00:00.000Z",
  updatedAt: "2026-10-11T00:00:00.000Z",
};

describe("draftProblem", () => {
  it("新建时逐项检查名字、展示名、地址", () => {
    expect(draftProblem(emptyDraft(), "create")).toBe("name");
    expect(draftProblem({ ...emptyDraft(), name: "a/b" }, "create")).toBe("name");
    expect(draftProblem({ ...emptyDraft(), name: "test" }, "create")).toBe("nameReserved");
    expect(draftProblem({ ...emptyDraft(), name: "ok" }, "create")).toBe("displayName");
    expect(draftProblem({ ...emptyDraft(), name: "ok", displayName: "OK" }, "create")).toBe("baseUrl");
    expect(draftProblem({ ...emptyDraft(), name: "ok", displayName: "OK", baseUrl: "ftp://x" }, "create")).toBe("baseUrl");
    expect(draftProblem({ ...emptyDraft(), name: "ok", displayName: "OK", baseUrl: "http://x" }, "create")).toBeNull();
  });

  it("密钥含空格或换行（例如整段粘进 Bearer sk-…）：apiKey；首尾空白会被 trim，不算", () => {
    const ok = { ...emptyDraft(), name: "ok", displayName: "OK", baseUrl: "http://x" };
    expect(draftProblem({ ...ok, apiKey: "Bearer sk-abc" }, "create")).toBe("apiKey");
    expect(draftProblem({ ...ok, apiKey: "sk-a\nbc" }, "create")).toBe("apiKey");
    expect(draftProblem({ ...ok, apiKey: "  sk-abc  " }, "create")).toBeNull();
    expect(draftProblem({ ...ok, apiKey: "" }, "create")).toBeNull();
    expect(draftProblem({ ...draftFromView(view), apiKey: "a b" }, "edit")).toBe("apiKey");
  });

  it("apiKeyDraftInvalid：供「测试连接」按钮判断", () => {
    expect(apiKeyDraftInvalid({ ...emptyDraft(), apiKey: "Bearer x" })).toBe(true);
    expect(apiKeyDraftInvalid({ ...emptyDraft(), apiKey: " sk-1 " })).toBe(false);
    expect(apiKeyDraftInvalid(emptyDraft())).toBe(false);
  });

  it("编辑时不检查名字（不可改）", () => {
    expect(draftProblem({ ...draftFromView(view), name: "" }, "edit")).toBeNull();
  });
});

describe("请求体构造", () => {
  it("新建：空的可选项不发送", () => {
    expect(buildCreateBody({ ...emptyDraft(), name: "ok", displayName: " OK ", baseUrl: " http://x " })).toEqual({
      name: "ok",
      displayName: "OK",
      baseUrl: "http://x",
    });
  });

  it("新建：填了的可选项原样带上", () => {
    expect(
      buildCreateBody({
        ...emptyDraft(),
        name: "ok",
        displayName: "OK",
        baseUrl: "http://x",
        apiKey: "sk-1",
        upstreamModel: "m",
        note: "n",
      }),
    ).toEqual({ name: "ok", displayName: "OK", baseUrl: "http://x", apiKey: "sk-1", upstreamModel: "m", note: "n" });
  });

  it("编辑：密钥留空表示不改，勾了清除才发空串", () => {
    const draft = draftFromView(view);
    expect(buildUpdateBody(draft)).toEqual({
      displayName: "Strata",
      baseUrl: "http://up:8080",
      upstreamModel: "qwen-real",
      note: "V100",
      aliases: [{ alias: "gpt-4.1", upstreamModel: "qwen-x" }, { alias: "plain" }],
    });
    expect(buildUpdateBody({ ...draft, apiKey: "sk-new" })).toMatchObject({ apiKey: "sk-new" });
    expect(buildUpdateBody({ ...draft, clearApiKey: true })).toMatchObject({ apiKey: "" });
  });

  it("编辑：清空的可选项发 null", () => {
    expect(buildUpdateBody({ ...draftFromView(view), upstreamModel: "", note: " " })).toMatchObject({
      upstreamModel: null,
      note: null,
    });
  });

  it("测试连接：编辑且没输入新密钥时带上名字，让服务端用已保存的密钥", () => {
    expect(buildTestBody(draftFromView(view), "edit")).toEqual({ baseUrl: "http://up:8080", name: "strata" });
    expect(buildTestBody({ ...draftFromView(view), apiKey: "sk-new" }, "edit")).toEqual({
      baseUrl: "http://up:8080",
      apiKey: "sk-new",
    });
    expect(buildTestBody({ ...draftFromView(view), clearApiKey: true }, "edit")).toEqual({
      baseUrl: "http://up:8080",
      apiKey: null,
    });
    expect(buildTestBody({ ...emptyDraft(), baseUrl: "http://x" }, "create")).toEqual({
      baseUrl: "http://x",
      apiKey: null,
    });
  });
});

describe("别名", () => {
  const ok = { ...emptyDraft(), name: "strata", displayName: "S", baseUrl: "http://x" };
  const rows = (...list: [string, string][]) => list.map(([alias, upstreamModel]) => ({ alias, upstreamModel }));

  it("emptyDraft 无别名；draftFromView 带入，空目标变空串", () => {
    expect(emptyDraft().aliases).toEqual([]);
    expect(draftFromView(view).aliases).toEqual(rows(["gpt-4.1", "qwen-x"], ["plain", ""]));
  });

  it("整行都空白的行被忽略，不影响校验", () => {
    const draft = { ...ok, aliases: rows(["", ""], ["  ", " "], ["a", ""]) };
    expect(aliasProblems(draft)).toEqual([]);
    expect(draftProblem(draft, "create")).toBeNull();
  });

  it("别名先 trim 再校验：两侧空白不算错", () => {
    expect(aliasProblems({ ...ok, aliases: rows([" gpt-4.1 ", ""]) })).toEqual([]);
  });

  it("格式非法、只填了目标没填别名：定位到那一行的 alias", () => {
    const draft = { ...ok, aliases: rows(["good", ""], ["has space", ""], ["", "target"]) };
    expect(aliasProblems(draft)).toEqual([
      { index: 1, field: "alias", reason: "format" },
      { index: 2, field: "alias", reason: "format" },
    ]);
    expect(draftProblem(draft, "create")).toBe("aliases");
  });

  it("重复：第二次出现的那一行报 duplicate；区分大小写", () => {
    expect(aliasProblems({ ...ok, aliases: rows(["a", ""], ["b", ""], ["a", ""]) })).toEqual([
      { index: 2, field: "alias", reason: "duplicate" },
    ]);
    expect(aliasProblems({ ...ok, aliases: rows(["a", ""], ["A", ""]) })).toEqual([]);
  });

  it("等于所属上游名称：ownerName", () => {
    expect(aliasProblems({ ...ok, aliases: rows(["x", ""], ["strata", ""]) })).toEqual([
      { index: 1, field: "alias", reason: "ownerName" },
    ]);
  });

  it("过长：别名 length，目标 targetLength", () => {
    const draft = { ...ok, aliases: rows(["a".repeat(129), ""], ["b", "t".repeat(257)]) };
    expect(aliasProblems(draft)).toEqual([
      { index: 0, field: "alias", reason: "length" },
      { index: 1, field: "upstreamModel", reason: "targetLength" },
    ]);
  });

  it("超过 50 行有内容的别名：整组 tooMany（空行不计）", () => {
    const many = Array.from({ length: 51 }, (_, i): [string, string] => [`a${i}`, ""]);
    expect(aliasProblems({ ...ok, aliases: rows(...many) })).toEqual([
      { index: null, field: "group", reason: "tooMany" },
    ]);
    expect(aliasProblems({ ...ok, aliases: rows(...many.slice(0, 50), ["", ""]) })).toEqual([]);
  });

  it("新建：没有有效别名行就不带 aliases；带时 trim，空目标不带 upstreamModel", () => {
    expect(buildCreateBody({ ...ok, aliases: rows(["", ""]) })).not.toHaveProperty("aliases");
    expect(buildCreateBody({ ...ok, aliases: rows([" a ", " t "], ["", ""], ["b", " "]) }).aliases).toEqual([
      { alias: "a", upstreamModel: "t" },
      { alias: "b" },
    ]);
  });

  it("编辑：总是带 aliases，清空发空数组", () => {
    expect(buildUpdateBody({ ...draftFromView(view), aliases: [] }).aliases).toEqual([]);
    expect(buildUpdateBody({ ...draftFromView(view), aliases: rows(["", ""]) }).aliases).toEqual([]);
  });

  it("409 的 aliases.N.alias 折算回草稿行（请求体丢了空白行）", () => {
    const draft = { ...ok, aliases: rows(["a", ""], ["", ""], ["c", ""]) };
    expect(aliasConflictRow(draft, "aliases.1.alias")).toBe(2);
    expect(aliasConflictRow(draft, "aliases.0.alias")).toBe(0);
    expect(aliasConflictRow(draft, "aliases.5.alias")).toBeNull();
    expect(aliasConflictRow(draft, "name")).toBeNull();
    expect(aliasConflictRow(draft, undefined)).toBeNull();
  });
});

describe("fieldProblems", () => {
  const touched = (...fields: DraftField[]) => new Set<DraftField>(fields);
  const valid = { ...emptyDraft(), name: "qwen3.8-flash", displayName: "Q", baseUrl: "http://10.0.0.5:8080" };

  it("全空且没碰过 → 一条红字都没有", () => {
    expect(fieldProblems(emptyDraft(), "create", touched())).toEqual({});
  });

  it("名称为空时不报格式错误，即使碰过", () => {
    expect(fieldProblems(emptyDraft(), "create", touched("name"))).toEqual({});
  });

  it("名称填了但格式不对 → 归到 name 字段", () => {
    expect(fieldProblems({ ...valid, name: "a/b" }, "create", touched())).toEqual({ name: "name" });
  });

  it("保留名 → name 字段，原因为 nameReserved", () => {
    expect(fieldProblems({ ...valid, name: "probe" }, "create", touched())).toEqual({ name: "nameReserved" });
  });

  it("编辑模式名称不可改，不报名称问题", () => {
    expect(fieldProblems({ ...valid, name: "probe" }, "edit", touched())).toEqual({});
  });

  it("展示名与地址为空：碰过才报", () => {
    const blank = { ...valid, displayName: "", baseUrl: "" };
    expect(fieldProblems(blank, "create", touched())).toEqual({});
    expect(fieldProblems(blank, "create", touched("displayName", "baseUrl"))).toEqual({
      displayName: "displayName",
      baseUrl: "baseUrl",
    });
  });

  it("地址填了但不合法 → 不必碰过就报", () => {
    expect(fieldProblems({ ...valid, baseUrl: "ftp://x" }, "create", touched())).toEqual({ baseUrl: "baseUrl" });
  });

  it("密钥含空格 → apiKey 字段", () => {
    expect(fieldProblems({ ...valid, apiKey: "sk a" }, "create", touched())).toEqual({ apiKey: "apiKey" });
  });

  it("别名问题不在字段映射里（逐行显示在别名行下）", () => {
    const draft = { ...valid, aliases: [{ alias: "bad alias", upstreamModel: "" }] };
    expect(fieldProblems(draft, "create", touched())).toEqual({});
  });

  it("全部合法 → 空对象", () => {
    expect(fieldProblems(valid, "create", touched("name", "displayName", "baseUrl"))).toEqual({});
  });
});
