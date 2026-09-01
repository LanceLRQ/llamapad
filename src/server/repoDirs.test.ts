import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb, runMigrations } from "./db";
import { listRepoDirs } from "./repoDirs";

/**
 * listRepoDirs 测试（批 3 第 4 项）：只验证「查表 + repoTargetDir 拼路径」
 * 这一件事本身，不重复 repoProfiles.test.ts 里对 createProfile 等编排逻辑
 * 的覆盖。
 */

interface World {
  db: Database.Database;
}

let world: World;

beforeEach(() => {
  const db = openDb(":memory:");
  runMigrations(db);
  world = { db };
});

afterEach(() => {
  world.db.close();
});

/** 直接建 model_repos 行：与 filesApi.test.ts / repoProfiles.test.ts 同款
 * 写法，不经完整的 repoProfiles.createProfile（那个还会顺带 mkdir + 写标记
 * 文件，这里只关心查表结果）。 */
function addRepoProfile(baseDir: string, repo: string): void {
  world.db
    .prepare("INSERT INTO model_repos(repo, base_dir, created_at) VALUES (?, ?, ?)")
    .run(repo, baseDir, Date.now());
}

describe("listRepoDirs", () => {
  it("无档案时返回空数组", () => {
    expect(listRepoDirs(world.db)).toEqual([]);
  });

  it("按 repoTargetDir 拼出每条档案的落盘目录", () => {
    addRepoProfile("hf", "o/r1");
    addRepoProfile("", "solo/repo");
    expect(listRepoDirs(world.db).sort()).toEqual(["hf/o/r1", "solo/repo"]);
  });

  it("多条档案全部返回，不去重、不排序（调用方自行处理）", () => {
    addRepoProfile("hf", "a/b");
    addRepoProfile("hf", "c/d");
    expect(listRepoDirs(world.db)).toHaveLength(2);
    expect(listRepoDirs(world.db)).toEqual(
      expect.arrayContaining(["hf/a/b", "hf/c/d"]),
    );
  });
});
