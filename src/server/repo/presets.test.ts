import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import { openDb, runMigrations } from "../db";
import {
  PresetError,
  createPreset,
  deletePreset,
  getPreset,
  listPresets,
  updatePreset,
} from "./presets";

let db: Database.Database;

beforeEach(() => {
  db = openDb(":memory:");
  runMigrations(db);
});

describe("createPreset", () => {
  it("落库并回读", () => {
    const p = createPreset(db, {
      name: "qwen3-thinking",
      description: "官方思考模式",
      server: { temp: 1, top_p: 0.95, top_k: 20 },
      source: "readme",
      sourceRepo: "unsloth/Qwen3.8-27B-GGUF",
    });

    expect(p.id).toBeGreaterThan(0);
    expect(getPreset(db, p.id)?.server).toEqual({ temp: 1, top_p: 0.95, top_k: 20 });
    expect(getPreset(db, p.id)?.sourceRepo).toBe("unsloth/Qwen3.8-27B-GGUF");
  });

  it("重名报 CONFLICT", () => {
    createPreset(db, { name: "dup", server: { temp: 1 } });
    expect(() => createPreset(db, { name: "dup", server: { temp: 2 } })).toThrow(PresetError);
    try {
      createPreset(db, { name: "dup", server: { temp: 2 } });
    } catch (e) {
      expect((e as PresetError).code).toBe("CONFLICT");
    }
  });

  it("空名字报 INVALID_NAME", () => {
    expect(() => createPreset(db, { name: "  ", server: { temp: 1 } })).toThrow(PresetError);
  });

  it("名字过长报 INVALID_NAME", () => {
    expect(() => createPreset(db, { name: "x".repeat(65), server: { temp: 1 } })).toThrow(PresetError);
  });

  it("空 server 报 INVALID_NAME —— 一条不含任何参数的预设没有意义", () => {
    expect(() => createPreset(db, { name: "empty", server: {} })).toThrow(PresetError);
  });

  it("server 里的非法值被 schema 拒掉（temp 上限 2）", () => {
    expect(() => createPreset(db, { name: "bad", server: { temp: 5 } as never })).toThrow();
  });

  it("server 里的未知键被拒（strict）", () => {
    expect(() =>
      createPreset(db, { name: "bad", server: { nope: 1 } as never }),
    ).toThrow();
  });

  it("source 缺省为 manual", () => {
    const p = createPreset(db, { name: "n", server: { temp: 1 } });
    expect(getPreset(db, p.id)?.source).toBe("manual");
  });
});

describe("listPresets", () => {
  it("按名称排序", () => {
    createPreset(db, { name: "b", server: { temp: 1 } });
    createPreset(db, { name: "a", server: { temp: 1 } });
    expect(listPresets(db).map((p) => p.name)).toEqual(["a", "b"]);
  });

  it("空库返回空数组", () => {
    expect(listPresets(db)).toEqual([]);
  });
});

describe("updatePreset", () => {
  it("改名与改描述", () => {
    const p = createPreset(db, { name: "old", server: { temp: 1 } });
    updatePreset(db, p.id, { name: "new", description: "说明" });
    expect(getPreset(db, p.id)?.name).toBe("new");
    expect(getPreset(db, p.id)?.description).toBe("说明");
  });

  it("改成已存在的名字报 CONFLICT", () => {
    createPreset(db, { name: "taken", server: { temp: 1 } });
    const p = createPreset(db, { name: "mine", server: { temp: 1 } });
    expect(() => updatePreset(db, p.id, { name: "taken" })).toThrow(PresetError);
  });

  it("改成自己原来的名字不算冲突", () => {
    const p = createPreset(db, { name: "same", server: { temp: 1 } });
    expect(() => updatePreset(db, p.id, { name: "same", description: "x" })).not.toThrow();
  });

  it("不存在报 NOT_FOUND", () => {
    expect(() => updatePreset(db, 999, { name: "x" })).toThrow(PresetError);
  });

  it("刷新 updated_at", () => {
    const p = createPreset(db, { name: "n", server: { temp: 1 } });
    db.prepare("UPDATE param_presets SET updated_at = 0 WHERE id = ?").run(p.id);
    updatePreset(db, p.id, { description: "x" });
    expect(getPreset(db, p.id)!.updatedAt).toBeGreaterThan(0);
  });
});

describe("deletePreset", () => {
  it("删掉后查不到", () => {
    const p = createPreset(db, { name: "n", server: { temp: 1 } });
    deletePreset(db, p.id);
    expect(getPreset(db, p.id)).toBeNull();
  });

  it("不存在报 NOT_FOUND", () => {
    expect(() => deletePreset(db, 999)).toThrow(PresetError);
  });
});
