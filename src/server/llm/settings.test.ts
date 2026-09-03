import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import { openDb, runMigrations } from "../db";
import { getLlmSettings, resolveLlmConfig, saveLlmSettings } from "./settings";

let db: Database.Database;
const ENV_KEYS = [
  "PANEL_LLM_BASE_URL",
  "PANEL_LLM_API_KEY",
  "PANEL_LLM_MODEL",
  "PANEL_LLM_EXTRA_BODY",
] as const;

beforeEach(() => {
  db = openDb(":memory:");
  runMigrations(db);
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("getLlmSettings", () => {
  it("全新库：引擎为 none，外部三项都没配", () => {
    const s = getLlmSettings(db);
    expect(s.engine).toBe("none");
    expect(s.externalReady).toBe(false);
    expect(s.missing).toEqual(["baseUrl", "apiKey", "model"]);
  });

  it("env 配齐三项即 ready，且来源标 env", () => {
    process.env.PANEL_LLM_BASE_URL = "https://api.example.com/v1";
    process.env.PANEL_LLM_API_KEY = "sk-0123456789abcdef";
    process.env.PANEL_LLM_MODEL = "gpt-4o-mini";

    const s = getLlmSettings(db);
    expect(s.externalReady).toBe(true);
    expect(s.missing).toEqual([]);
    expect(s.baseUrlSource).toBe("env");
    expect(s.keySource).toBe("env");
  });

  // 缺项要逐项点名，用户回设置页才知道补哪个
  it("只配了两项时，missing 精确指出缺的那一项", () => {
    process.env.PANEL_LLM_BASE_URL = "https://api.example.com/v1";
    process.env.PANEL_LLM_MODEL = "gpt-4o-mini";

    expect(getLlmSettings(db).missing).toEqual(["apiKey"]);
  });

  it("API Key 永不回明文，只回尾 4 位", () => {
    process.env.PANEL_LLM_API_KEY = "sk-0123456789abcdef";
    const s = getLlmSettings(db);

    expect(s.keyTail).toBe("cdef");
    expect(s.keySet).toBe(true);
    expect(JSON.stringify(s)).not.toContain("sk-0123456789abcdef");
  });

  it("env 优先于 db，且 env 来源在 UI 上应表现为只读", () => {
    saveLlmSettings(db, { baseUrl: "https://db.example.com/v1" });
    process.env.PANEL_LLM_BASE_URL = "https://env.example.com/v1";

    const s = getLlmSettings(db);
    expect(s.baseUrl).toBe("https://env.example.com/v1");
    expect(s.baseUrlSource).toBe("env");
  });

  it("env 缺席时落回 db", () => {
    saveLlmSettings(db, { baseUrl: "https://db.example.com/v1", model: "m", apiKey: "k-abcd1234" });

    const s = getLlmSettings(db);
    expect(s.baseUrl).toBe("https://db.example.com/v1");
    expect(s.baseUrlSource).toBe("db");
    expect(s.externalReady).toBe(true);
  });
});

describe("saveLlmSettings", () => {
  it("engine 只存 db，没有 env 覆盖", () => {
    saveLlmSettings(db, { engine: "external" });
    expect(getLlmSettings(db).engine).toBe("external");
  });

  it("apiKey 传 null 清除 db 里的那份", () => {
    saveLlmSettings(db, { apiKey: "k-abcd1234" });
    expect(getLlmSettings(db).keySet).toBe(true);

    saveLlmSettings(db, { apiKey: null });
    expect(getLlmSettings(db).keySet).toBe(false);
  });

  it("只传一项时不影响其他项", () => {
    saveLlmSettings(db, { baseUrl: "https://a.example.com/v1", model: "m" });
    saveLlmSettings(db, { model: "m2" });

    const s = getLlmSettings(db);
    expect(s.baseUrl).toBe("https://a.example.com/v1");
    expect(s.model).toBe("m2");
  });
});

describe("resolveLlmConfig", () => {
  it("回明文供服务端发请求用（这是唯一能拿到明文的入口）", () => {
    process.env.PANEL_LLM_API_KEY = "sk-secret-value";
    process.env.PANEL_LLM_BASE_URL = "https://api.example.com/v1/";
    process.env.PANEL_LLM_MODEL = "m";

    const c = resolveLlmConfig(db);
    expect(c.apiKey).toBe("sk-secret-value");
    // 末尾斜杠归一化掉：下游一律用 `${baseUrl}/chat/completions` 拼
    expect(c.baseUrl).toBe("https://api.example.com/v1");
  });

  it("extraBody 非法时降级为 null，不影响其余配置", () => {
    process.env.PANEL_LLM_EXTRA_BODY = "{不是 JSON";
    process.env.PANEL_LLM_MODEL = "m";

    const c = resolveLlmConfig(db);
    expect(c.extraBody).toBeNull();
    expect(c.model).toBe("m");
  });
});
