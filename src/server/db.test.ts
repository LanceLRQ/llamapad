import { describe, it, expect } from "vitest";
import { runMigrations, openDb } from "./db";

it("迁移后包含全部表且版本正确", () => {
  const db = openDb(":memory:");
  runMigrations(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
  for (const t of ["namespaces", "models", "settings", "admins", "api_tokens", "events"])
    expect(tables).toContain(t);
  expect(db.pragma("user_version", { simple: true })).toBe(1);
});

it("重复执行迁移是幂等的", () => {
  const db = openDb(":memory:");
  runMigrations(db);
  runMigrations(db); // 不应抛错、不重复建表
  expect(db.pragma("user_version", { simple: true })).toBe(1);
});
