import { describe, expect, it } from "vitest";
import type { UpstreamView } from "./upstream-types";
import { buildCreateBody, buildTestBody, buildUpdateBody, draftFromView, draftProblem, emptyDraft } from "./upstream-form";

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
  createdAt: "2026-10-11T00:00:00.000Z",
  updatedAt: "2026-10-11T00:00:00.000Z",
};

describe("draftProblem", () => {
  it("新建时逐项检查名字、展示名、地址", () => {
    expect(draftProblem(emptyDraft(), "create")).toBe("name");
    expect(draftProblem({ ...emptyDraft(), name: "Bad" }, "create")).toBe("name");
    expect(draftProblem({ ...emptyDraft(), name: "test" }, "create")).toBe("nameReserved");
    expect(draftProblem({ ...emptyDraft(), name: "ok" }, "create")).toBe("displayName");
    expect(draftProblem({ ...emptyDraft(), name: "ok", displayName: "OK" }, "create")).toBe("baseUrl");
    expect(draftProblem({ ...emptyDraft(), name: "ok", displayName: "OK", baseUrl: "ftp://x" }, "create")).toBe("baseUrl");
    expect(draftProblem({ ...emptyDraft(), name: "ok", displayName: "OK", baseUrl: "http://x" }, "create")).toBeNull();
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
