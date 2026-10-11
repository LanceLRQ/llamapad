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

  it("名字不合法 / 保留名 / 地址不合法 → INVALID", () => {
    expect(codeOf(() => createUpstream(db, { ...base, name: "Bad" }))).toBe("INVALID");
    expect(codeOf(() => createUpstream(db, { ...base, name: "probe" }))).toBe("INVALID");
    expect(codeOf(() => createUpstream(db, { ...base, baseUrl: "ftp://x" }))).toBe("INVALID");
    expect(codeOf(() => createUpstream(db, { ...base, displayName: "  " }))).toBe("INVALID");
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
