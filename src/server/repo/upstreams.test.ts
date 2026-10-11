import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import { openDb, runMigrations } from "../db";
import { ModelNameConflictError } from "../modelErrors";
import { createModelRepo } from "./models";
import {
  UpstreamError,
  clearDefaultUpstream,
  createUpstream,
  deleteUpstream,
  getDefaultUpstream,
  getUpstream,
  listAliasRoutes,
  listUpstreams,
  setDefaultUpstream,
  updateUpstream,
} from "./upstreams";

let db: Database.Database;

beforeEach(() => {
  db = openDb(":memory:");
  runMigrations(db);
});

const base = { name: "strata", displayName: "Strata", baseUrl: "http://10.0.0.5:8080/v1/" };

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
  } catch (error) {
    return error instanceof UpstreamError ? error.code : `other:${String(error)}`;
  }
  return null;
}

describe("createUpstream", () => {
  it("落库并回读，地址被规范化，缺省启用", () => {
    const created = createUpstream(db, { ...base, apiKey: "sk-secret", upstreamModel: "qwen", note: "V100" });
    expect(created).toMatchObject({
      name: "strata",
      displayName: "Strata",
      baseUrl: "http://10.0.0.5:8080",
      apiKey: "sk-secret",
      upstreamModel: "qwen",
      enabled: true,
      note: "V100",
    });
    expect(getUpstream(db, "strata")).toEqual(created);
  });

  it("空白的可选字段存为 null", () => {
    const created = createUpstream(db, { ...base, apiKey: "  ", upstreamModel: "", note: " " });
    expect(created.apiKey).toBeNull();
    expect(created.upstreamModel).toBeNull();
    expect(created.note).toBeNull();
  });

  it("密钥含换行 → INVALID", () => {
    expect(codeOf(() => createUpstream(db, { ...base, apiKey: "sk-a\nb" }))).toBe("INVALID");
    expect(getUpstream(db, "strata")).toBeNull();
  });

  it("名字不合法 / 保留名 / 地址不合法 → INVALID", () => {
    expect(codeOf(() => createUpstream(db, { ...base, name: "a/b" }))).toBe("INVALID");
    expect(codeOf(() => createUpstream(db, { ...base, name: "a:b" }))).toBe("INVALID");
    expect(codeOf(() => createUpstream(db, { ...base, name: "probe" }))).toBe("INVALID");
    expect(codeOf(() => createUpstream(db, { ...base, baseUrl: "ftp://x" }))).toBe("INVALID");
    expect(codeOf(() => createUpstream(db, { ...base, displayName: "  " }))).toBe("INVALID");
  });

  it("名字含大写与点号：增改删与读取都按原样精确匹配", () => {
    const created = createUpstream(db, { ...base, name: "Qwen3.8-Flash" });
    expect(created.name).toBe("Qwen3.8-Flash");
    expect(getUpstream(db, "Qwen3.8-Flash")).not.toBeNull();
    expect(getUpstream(db, "qwen3.8-flash")).toBeNull();
    // 大小写不同视为不同的名字，与别名、托管模型名的唯一性比较一致
    expect(() => createUpstream(db, { ...base, name: "qwen3.8-flash" })).not.toThrow();
    expect(codeOf(() => createUpstream(db, { ...base, name: "Qwen3.8-Flash" }))).toBe("CONFLICT");
    expect(updateUpstream(db, "Qwen3.8-Flash", { displayName: "新名" }).displayName).toBe("新名");
    deleteUpstream(db, "Qwen3.8-Flash");
    expect(getUpstream(db, "Qwen3.8-Flash")).toBeNull();
  });

  it("与已有上游或托管模型重名 → CONFLICT", () => {
    createUpstream(db, base);
    expect(codeOf(() => createUpstream(db, base))).toBe("CONFLICT");

    createModelRepo(db).createModel({
      name: "qwen",
      display_name: "Qwen",
      namespace: "main",
      gguf_file: "main/a.gguf",
      overrides: {},
    });
    expect(codeOf(() => createUpstream(db, { ...base, name: "qwen" }))).toBe("CONFLICT");
  });
});

describe("托管模型不能与上游重名", () => {
  it("createModel 抛 ModelNameConflictError", () => {
    createUpstream(db, base);
    expect(() =>
      createModelRepo(db).createModel({
        name: "strata",
        display_name: "x",
        namespace: "main",
        gguf_file: "main/a.gguf",
        overrides: {},
      }),
    ).toThrow(ModelNameConflictError);
  });
});

describe("updateUpstream", () => {
  it("只改给出的字段；apiKey 缺席不动、空串清除", () => {
    createUpstream(db, { ...base, apiKey: "sk-secret" });

    expect(updateUpstream(db, "strata", { displayName: "S2" }).apiKey).toBe("sk-secret");
    expect(updateUpstream(db, "strata", { apiKey: "sk-new" }).apiKey).toBe("sk-new");
    expect(updateUpstream(db, "strata", { apiKey: "" }).apiKey).toBeNull();
    expect(updateUpstream(db, "strata", { enabled: false }).enabled).toBe(false);
    expect(updateUpstream(db, "strata", { baseUrl: "https://x.example.com/v1" }).baseUrl).toBe("https://x.example.com");
    expect(getUpstream(db, "strata")?.displayName).toBe("S2");
  });

  it("密钥含非法字符 → INVALID，库里的值不变", () => {
    createUpstream(db, { ...base, apiKey: "sk-secret" });
    expect(codeOf(() => updateUpstream(db, "strata", { apiKey: "密钥" }))).toBe("INVALID");
    expect(getUpstream(db, "strata")?.apiKey).toBe("sk-secret");
  });

  it("不存在 → NOT_FOUND；地址不合法 → INVALID", () => {
    expect(codeOf(() => updateUpstream(db, "nope", { note: "x" }))).toBe("NOT_FOUND");
    createUpstream(db, base);
    expect(codeOf(() => updateUpstream(db, "strata", { baseUrl: "nope" }))).toBe("INVALID");
  });
});

describe("默认上游", () => {
  it("设置、读取、清除", () => {
    createUpstream(db, base);
    expect(getDefaultUpstream(db)).toBeNull();
    setDefaultUpstream(db, "strata");
    expect(getDefaultUpstream(db)).toBe("strata");
    clearDefaultUpstream(db);
    expect(getDefaultUpstream(db)).toBeNull();
  });

  it("设置不存在的上游 → NOT_FOUND", () => {
    expect(codeOf(() => setDefaultUpstream(db, "nope"))).toBe("NOT_FOUND");
  });

  it("删除默认上游时一并清除默认；停用不清除", () => {
    createUpstream(db, base);
    setDefaultUpstream(db, "strata");
    updateUpstream(db, "strata", { enabled: false });
    expect(getDefaultUpstream(db)).toBe("strata");
    deleteUpstream(db, "strata");
    expect(getDefaultUpstream(db)).toBeNull();
    expect(listUpstreams(db)).toEqual([]);
  });

  it("指向已不存在的上游（脏数据）→ 读取时返回 null 并删除该键", () => {
    db.prepare("INSERT INTO settings(key, value) VALUES ('default_upstream', 'ghost')").run();
    expect(getDefaultUpstream(db)).toBeNull();
    expect(db.prepare("SELECT 1 FROM settings WHERE key = 'default_upstream'").get()).toBeUndefined();
  });
});

describe("deleteUpstream", () => {
  it("不存在 → NOT_FOUND", () => {
    expect(codeOf(() => deleteUpstream(db, "nope"))).toBe("NOT_FOUND");
  });
});

function fieldOf(fn: () => unknown): { code: string; field: string | undefined } | null {
  try {
    fn();
  } catch (error) {
    if (error instanceof UpstreamError) return { code: error.code, field: error.field };
    throw error;
  }
  return null;
}

function addModel(name: string): void {
  createModelRepo(db).createModel({
    name,
    display_name: name,
    namespace: "main",
    gguf_file: `main/${name}.gguf`,
    overrides: {},
  });
}

describe("上游别名", () => {
  it("创建时带别名并回读：顺序保持，目标空白归 null，同目标允许", () => {
    const created = createUpstream(db, {
      ...base,
      aliases: [
        { alias: "gpt-4.1", upstreamModel: " big " },
        { alias: "Qwen3.8-Flash", upstreamModel: "big" },
        { alias: "org/model:tag", upstreamModel: "  " },
        { alias: "a_b" },
      ],
    });
    const expected = [
      { alias: "gpt-4.1", upstreamModel: "big" },
      { alias: "Qwen3.8-Flash", upstreamModel: "big" },
      { alias: "org/model:tag", upstreamModel: null },
      { alias: "a_b", upstreamModel: null },
    ];
    expect(created.aliases).toEqual(expected);
    expect(getUpstream(db, "strata")?.aliases).toEqual(expected);
    expect(listUpstreams(db)[0].aliases).toEqual(expected);
  });

  it("创建时缺席 = 没有别名", () => {
    expect(createUpstream(db, base).aliases).toEqual([]);
  });

  it("listUpstreams 按上游分组各自带别名", () => {
    createUpstream(db, { ...base, aliases: [{ alias: "a1" }, { alias: "a2" }] });
    createUpstream(db, { ...base, name: "other", aliases: [{ alias: "b1" }] });
    createUpstream(db, { ...base, name: "plain" });
    const byName = Object.fromEntries(listUpstreams(db).map((u) => [u.name, u.aliases.map((a) => a.alias)]));
    expect(byName).toEqual({ other: ["b1"], plain: [], strata: ["a1", "a2"] });
  });

  it("更新：缺席不改，整表替换，空数组清空", () => {
    createUpstream(db, { ...base, aliases: [{ alias: "a1", upstreamModel: "m" }, { alias: "a2" }] });

    const untouched = updateUpstream(db, "strata", { note: "x" });
    expect(untouched.aliases.map((a) => a.alias)).toEqual(["a1", "a2"]);

    const replaced = updateUpstream(db, "strata", { aliases: [{ alias: "a2" }, { alias: "a3", upstreamModel: "n" }, { alias: "a1" }] });
    expect(replaced.aliases).toEqual([
      { alias: "a2", upstreamModel: null },
      { alias: "a3", upstreamModel: "n" },
      { alias: "a1", upstreamModel: null },
    ]);

    expect(updateUpstream(db, "strata", { aliases: [] }).aliases).toEqual([]);
    expect(listAliasRoutes(db)).toEqual([]);
  });

  it("格式、超长、目标超长、组内重复、超上限、等于所属上游名 → INVALID 并指到字段", () => {
    const attempt = (aliases: { alias: string; upstreamModel?: string | null }[]) =>
      fieldOf(() => createUpstream(db, { ...base, aliases }));
    expect(attempt([{ alias: "ok" }, { alias: "-bad" }])).toEqual({ code: "INVALID", field: "aliases.1.alias" });
    expect(attempt([{ alias: "has space" }])).toEqual({ code: "INVALID", field: "aliases.0.alias" });
    expect(attempt([{ alias: "a".repeat(129) }])).toEqual({ code: "INVALID", field: "aliases.0.alias" });
    expect(attempt([{ alias: "a", upstreamModel: "x".repeat(257) }])).toEqual({
      code: "INVALID",
      field: "aliases.0.upstreamModel",
    });
    expect(attempt([{ alias: "a" }, { alias: "b" }, { alias: "a" }])).toEqual({ code: "INVALID", field: "aliases.2.alias" });
    expect(attempt(Array.from({ length: 51 }, (_, i) => ({ alias: `a${i}` })))).toEqual({
      code: "INVALID",
      field: "aliases",
    });
    expect(attempt([{ alias: "strata" }])).toEqual({ code: "INVALID", field: "aliases.0.alias" });
    expect(getUpstream(db, "strata")).toBeNull();
  });

  it("错误消息用 INVALID 前缀并带别名本身", () => {
    try {
      createUpstream(db, { ...base, aliases: [{ alias: "-bad" }] });
    } catch (error) {
      expect((error as Error).message).toMatch(/^INVALID: .*-bad/);
      return;
    }
    throw new Error("应当抛错");
  });

  it("与托管模型名、其他上游名称、其他上游别名冲突 → CONFLICT", () => {
    addModel("qwen");
    createUpstream(db, { ...base, name: "other", aliases: [{ alias: "taken" }] });
    expect(fieldOf(() => createUpstream(db, { ...base, aliases: [{ alias: "x" }, { alias: "qwen" }] }))).toEqual({
      code: "CONFLICT",
      field: "aliases.1.alias",
    });
    expect(fieldOf(() => createUpstream(db, { ...base, aliases: [{ alias: "other" }] }))).toEqual({
      code: "CONFLICT",
      field: "aliases.0.alias",
    });
    expect(fieldOf(() => createUpstream(db, { ...base, aliases: [{ alias: "taken" }] }))).toEqual({
      code: "CONFLICT",
      field: "aliases.0.alias",
    });
    expect(getUpstream(db, "strata")).toBeNull();
  });

  it("更新时同一上游原有的别名不算冲突", () => {
    createUpstream(db, { ...base, aliases: [{ alias: "a1" }, { alias: "a2" }] });
    const updated = updateUpstream(db, "strata", { aliases: [{ alias: "a2", upstreamModel: "m" }, { alias: "a1" }] });
    expect(updated.aliases[0]).toEqual({ alias: "a2", upstreamModel: "m" });
  });

  it("更新时别名冲突 → 整次更新不生效", () => {
    createUpstream(db, { ...base, note: "old", aliases: [{ alias: "a1" }] });
    createUpstream(db, { ...base, name: "other", aliases: [{ alias: "taken" }] });
    expect(
      fieldOf(() => updateUpstream(db, "strata", { note: "new", displayName: "New", aliases: [{ alias: "taken" }] })),
    ).toEqual({ code: "CONFLICT", field: "aliases.0.alias" });
    const after = getUpstream(db, "strata")!;
    expect(after.note).toBe("old");
    expect(after.displayName).toBe("Strata");
    expect(after.aliases.map((a) => a.alias)).toEqual(["a1"]);
  });

  it("更新时别名非法 → INVALID 且其他字段不变", () => {
    createUpstream(db, { ...base, note: "old" });
    expect(fieldOf(() => updateUpstream(db, "strata", { note: "new", aliases: [{ alias: "strata" }] }))).toEqual({
      code: "INVALID",
      field: "aliases.0.alias",
    });
    expect(getUpstream(db, "strata")?.note).toBe("old");
  });

  it("删除上游后别名消失，同名别名可被别的上游再用", () => {
    createUpstream(db, { ...base, aliases: [{ alias: "shared" }] });
    deleteUpstream(db, "strata");
    expect(listAliasRoutes(db)).toEqual([]);
    const other = createUpstream(db, { ...base, name: "other", aliases: [{ alias: "shared" }] });
    expect(other.aliases).toEqual([{ alias: "shared", upstreamModel: null }]);
  });

  it("新建上游撞上已有别名 → CONFLICT 指到 name", () => {
    createUpstream(db, { ...base, aliases: [{ alias: "gpt-4" }] });
    expect(fieldOf(() => createUpstream(db, { ...base, name: "gpt-4" }))).toEqual({ code: "CONFLICT", field: "name" });
  });

  it("新建托管模型撞上已有别名 → ModelNameConflictError", () => {
    createUpstream(db, { ...base, aliases: [{ alias: "gpt-4" }] });
    expect(() => addModel("gpt-4")).toThrow(ModelNameConflictError);
  });

  it("listAliasRoutes 一次返回全部别名及所属上游", () => {
    createUpstream(db, { ...base, aliases: [{ alias: "a1", upstreamModel: "m" }, { alias: "a2" }] });
    createUpstream(db, { ...base, name: "other", aliases: [{ alias: "b1" }] });
    expect(listAliasRoutes(db)).toEqual(
      expect.arrayContaining([
        { alias: "a1", upstream: "strata", upstreamModel: "m" },
        { alias: "a2", upstream: "strata", upstreamModel: null },
        { alias: "b1", upstream: "other", upstreamModel: null },
      ]),
    );
    expect(listAliasRoutes(db)).toHaveLength(3);
  });
});
