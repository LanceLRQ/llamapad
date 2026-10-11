import { describe, expect, it } from "vitest";

import {
  ALIAS_MAX_LENGTH,
  ALIAS_TARGET_MAX_LENGTH,
  MAX_ALIASES_PER_UPSTREAM,
  aliasProblem,
  normalizeAliases,
} from "./upstream-alias";

describe("aliasProblem", () => {
  it.each(["gpt-4.1", "Qwen3.8-Flash", "org/model:tag", "a_b", "a", "1x"])("合法：%s", (alias) => {
    expect(aliasProblem(alias)).toBeNull();
  });

  it.each(["", "-a", ".a", "_a", "a b", " a", "a ", "模型", "a中"])("格式非法：%j", (alias) => {
    expect(aliasProblem(alias)).toBe("format");
  });

  it("长度边界：128 合法，129 超长", () => {
    expect(aliasProblem("a".repeat(ALIAS_MAX_LENGTH))).toBeNull();
    expect(aliasProblem("a".repeat(ALIAS_MAX_LENGTH + 1))).toBe("length");
  });

  it("超长且格式也不对时先报格式", () => {
    expect(aliasProblem("-" + "a".repeat(ALIAS_MAX_LENGTH))).toBe("format");
  });
});

describe("normalizeAliases", () => {
  it("目标去首尾空白，空串与缺省归 null，顺序保持", () => {
    const result = normalizeAliases(
      [
        { alias: "b", upstreamModel: "  m1  " },
        { alias: "a", upstreamModel: "   " },
        { alias: "c" },
        { alias: "d", upstreamModel: null },
      ],
      "strata",
    );
    expect(result).toEqual({
      ok: true,
      aliases: [
        { alias: "b", upstreamModel: "m1" },
        { alias: "a", upstreamModel: null },
        { alias: "c", upstreamModel: null },
        { alias: "d", upstreamModel: null },
      ],
    });
  });

  it("多个别名指向同一目标是允许的", () => {
    const result = normalizeAliases([{ alias: "a", upstreamModel: "m" }, { alias: "b", upstreamModel: "m" }], "strata");
    expect(result.ok).toBe(true);
  });

  it("空数组合法", () => {
    expect(normalizeAliases([], "strata")).toEqual({ ok: true, aliases: [] });
  });

  it("别名首尾空白不被 trim，判为格式错误", () => {
    expect(normalizeAliases([{ alias: "a " }], "strata")).toEqual({
      ok: false,
      index: 0,
      field: "alias",
      reason: "format",
    });
  });

  it("格式、长度错误指到下标与 alias 字段", () => {
    expect(normalizeAliases([{ alias: "ok" }, { alias: "-bad" }], "strata")).toEqual({
      ok: false,
      index: 1,
      field: "alias",
      reason: "format",
    });
    expect(normalizeAliases([{ alias: "a".repeat(129) }], "strata")).toEqual({
      ok: false,
      index: 0,
      field: "alias",
      reason: "length",
    });
  });

  it("目标超长指到 upstreamModel 字段，256 恰好合法", () => {
    expect(normalizeAliases([{ alias: "a", upstreamModel: "x".repeat(ALIAS_TARGET_MAX_LENGTH) }], "s").ok).toBe(true);
    expect(normalizeAliases([{ alias: "a" }, { alias: "b", upstreamModel: "x".repeat(257) }], "s")).toEqual({
      ok: false,
      index: 1,
      field: "upstreamModel",
      reason: "targetLength",
    });
  });

  it("条数上限：50 合法，51 报整组", () => {
    const make = (n: number) => Array.from({ length: n }, (_, i) => ({ alias: `a${i}` }));
    expect(normalizeAliases(make(MAX_ALIASES_PER_UPSTREAM), "s").ok).toBe(true);
    expect(normalizeAliases(make(MAX_ALIASES_PER_UPSTREAM + 1), "s")).toEqual({
      ok: false,
      index: null,
      field: "group",
      reason: "tooMany",
    });
  });

  it("组内重复指到后出现的那条，区分大小写", () => {
    expect(normalizeAliases([{ alias: "a" }, { alias: "b" }, { alias: "a" }], "s")).toEqual({
      ok: false,
      index: 2,
      field: "alias",
      reason: "duplicate",
    });
    expect(normalizeAliases([{ alias: "a" }, { alias: "A" }], "s").ok).toBe(true);
  });

  it("等于所属上游名称", () => {
    expect(normalizeAliases([{ alias: "x" }, { alias: "strata" }], "strata")).toEqual({
      ok: false,
      index: 1,
      field: "alias",
      reason: "ownerName",
    });
  });

  it("返回第一个问题", () => {
    const result = normalizeAliases([{ alias: "a" }, { alias: "-x" }, { alias: "a" }], "s");
    expect(result).toMatchObject({ ok: false, index: 1, reason: "format" });
  });
});
