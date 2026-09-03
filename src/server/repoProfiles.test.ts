import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, runMigrations } from "./db";
import { createModelRepo, type ModelRepo } from "./repo/models";
import type { ModelConfig } from "../core/schemas";
import type { FolderFiles } from "./fsScanner";
import {
  createProfile,
  decorateProfileStats,
  deleteProfile,
  listProfiles,
  moveProfile,
  RepoProfileError,
  scanRepoMarkers,
  REPO_MARKER_FILENAME,
  type RepoProfile,
} from "./repoProfiles";

/**
 * 仓库档案服务层测试（批 1，TDD）。
 *
 * 与 folders.test.ts 同款搭台：临时 models 根 + 内存 db，runningModel 直接以
 * 字符串塞进 deps —— LOCKED 判定只需要「当前运行的是哪个模型」，不必搭
 * mock docker 适配器。
 */

interface World {
  db: Database.Database;
  repo: ModelRepo;
  root: string;
  /** 宿主视角根：与 root 是两个不同的临时目录，全程必须保持空——见
   * expectHostRootEmpty（任务 H 回归锁） */
  hostRoot: string;
}

let world: World;

function touch(rel: string, bytes = 1): void {
  const abs = path.join(world.root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, Buffer.alloc(bytes, "x"));
}

function addModel(partial: Partial<ModelConfig> & { name: string }): void {
  world.repo.createModel({
    display_name: partial.name,
    namespace: "main",
    gguf_file: partial.gguf_file ?? "main/x.gguf",
    overrides: {},
    ...partial,
  } as ModelConfig);
}

function deps(runningModel: string | null = null) {
  return { db: world.db, modelsRoot: world.root, runningModel };
}

/** 全程必须为空的宿主根断言：repoProfiles.ts 不该有任何写盘落在这里 */
function expectHostRootEmpty(): void {
  expect(readdirSync(world.hostRoot)).toEqual([]);
}

beforeEach(() => {
  const root = mkdtempSync(path.join(tmpdir(), "llamapad-repos-"));
  const hostRoot = mkdtempSync(path.join(tmpdir(), "llamapad-repos-host-"));
  const db = openDb(":memory:");
  runMigrations(db);
  world = { db, repo: createModelRepo(db), root, hostRoot };
});

afterEach(() => {
  world.db.close();
  rmSync(world.root, { recursive: true, force: true });
  rmSync(world.hostRoot, { recursive: true, force: true });
});

describe("createProfile", () => {
  it("建出目录、写入标记文件、落 DB 行", () => {
    const p = createProfile(deps(), { repo: "unsloth/Qwen3.5-4B-GGUF", baseDir: "hf" });
    expect(p.targetDir).toBe("hf/unsloth/Qwen3.5-4B-GGUF");
    expect(existsSync(path.join(world.root, p.targetDir))).toBe(true);
    const marker = path.join(world.root, p.targetDir, REPO_MARKER_FILENAME);
    expect(JSON.parse(readFileSync(marker, "utf8")).repo).toBe("unsloth/Qwen3.5-4B-GGUF");
    expect(listProfiles(world.db)).toHaveLength(1);
    // 回归锁（任务 H）：mkdir/writeFile 只准落在面板视角根，宿主视角根全程为空
    expectHostRootEmpty();
  });

  it("base 为空串时落在 models 根下", () => {
    const p = createProfile(deps(), { repo: "o/r", baseDir: "" });
    expect(p.targetDir).toBe("o/r");
  });

  it("同 base 同 repo 重复创建报 CONFLICT", () => {
    createProfile(deps(), { repo: "o/r", baseDir: "hf" });
    expect(() => createProfile(deps(), { repo: "o/r", baseDir: "hf" })).toThrow(RepoProfileError);
  });

  it("同 repo 不同 base 允许并存", () => {
    createProfile(deps(), { repo: "o/r", baseDir: "hf" });
    expect(() => createProfile(deps(), { repo: "o/r", baseDir: "qwen3.8" })).not.toThrow();
  });

  it("目录已存在且有标记文件时直接认领，不报错", () => {
    touch(`hf/o/r/${REPO_MARKER_FILENAME}`);
    writeFileSync(
      path.join(world.root, "hf/o/r", REPO_MARKER_FILENAME),
      JSON.stringify({ repo: "o/r", createdAt: 1 }),
    );
    const p = createProfile(deps(), { repo: "o/r", baseDir: "hf" });
    expect(p.claimed).toBe(true);
  });

  it("认领已带标记文件的目录时不覆写标记，createdAt 保留原值（M4：与 repair 路由同一不变量）", () => {
    const staleCreatedAt = 1000; // 明显偏旧，便于与 Date.now() 区分
    touch(`hf/o/r/${REPO_MARKER_FILENAME}`);
    writeFileSync(
      path.join(world.root, "hf/o/r", REPO_MARKER_FILENAME),
      JSON.stringify({ repo: "o/r", createdAt: staleCreatedAt }),
    );
    createProfile(deps(), { repo: "o/r", baseDir: "hf" });
    const marker = path.join(world.root, "hf/o/r", REPO_MARKER_FILENAME);
    expect(JSON.parse(readFileSync(marker, "utf8")).createdAt).toBe(staleCreatedAt);
  });

  it("目录已存在但没有标记文件时也认领并补写标记——多级路径巧合概率为零", () => {
    touch("hf/o/r/model.gguf");
    const p = createProfile(deps(), { repo: "o/r", baseDir: "hf" });
    expect(p.claimed).toBe(true);
    expect(existsSync(path.join(world.root, "hf/o/r", REPO_MARKER_FILENAME))).toBe(true);
  });

  it("非法 repo 报 INVALID_NAME", () => {
    expect(() => createProfile(deps(), { repo: "../etc", baseDir: "hf" })).toThrow(
      /INVALID_NAME/,
    );
  });

  it("非法 base 报 INVALID_NAME", () => {
    expect(() => createProfile(deps(), { repo: "o/r", baseDir: "../x" })).toThrow(/INVALID_NAME/);
  });

  // 缺陷 2（批 2）：唯一性此前只按 (base_dir, repo) 精确判，两种拆法能派生
  // 出同一落盘 targetDir（"hf/o" + "R" 与 "hf" + "o/R" 都是 "hf/o/R"），
  // DB 的 UNIQUE(base_dir, repo) 挡不住——两条档案行共管一个目录，删其中
  // 一条的文件会把另一条的文件一起 rmSync 掉。
  it("两种 base/repo 拆法派生出同一落盘目录 → 第二次 createProfile 报 CONFLICT（缺陷 2 回归锁）", () => {
    createProfile(deps(), { repo: "R", baseDir: "hf/o" });
    expect(() => createProfile(deps(), { repo: "o/R", baseDir: "hf" })).toThrow(/CONFLICT/);
    // 第二次未落库、未建目录：只应存在第一次那一条档案
    expect(listProfiles(world.db)).toHaveLength(1);
  });

  it("新档案目标目录落在某个既有档案目录内部 → 报 CONFLICT（档案不得互相嵌套）", () => {
    createProfile(deps(), { repo: "o/R", baseDir: "hf" });
    expect(() => createProfile(deps(), { repo: "extra", baseDir: "hf/o/R" })).toThrow(/CONFLICT/);
    expect(listProfiles(world.db)).toHaveLength(1);
  });

  it("新档案目标目录是某个既有档案目录的祖先目录 → 报 CONFLICT（反向嵌套同样拒绝）", () => {
    createProfile(deps(), { repo: "sub/R", baseDir: "hf/o" });
    // 待建目录 "hf/o" 是既有档案 "hf/o/sub/R" 的祖先
    expect(() => createProfile(deps(), { repo: "o", baseDir: "hf" })).toThrow(/CONFLICT/);
    expect(listProfiles(world.db)).toHaveLength(1);
  });

  // 目录段数上限比 fsScanner 的 MAX_PATH_DEPTH（路径总段数，含文件名段）少
  // 1：目录里的文件至少还要占一段，8 段目录建出来后其内文件必为 9 段，会
  // 被 walkTree 整个跳过（建得出来但全站看不见），见 fsScanner.ts 顶部注释。
  it("落盘目录层级超过目录段数上限（7 层）报 INVALID_NAME", () => {
    expect(() =>
      createProfile(deps(), { repo: "e/f/g/h", baseDir: "a/b/c/d" }), // 8 段
    ).toThrow(/INVALID_NAME/);
    expect(existsSync(path.join(world.root, "a"))).toBe(false);
  });

  it("落盘目录层级恰为目录段数上限（7 层）仍可建", () => {
    const p = createProfile(deps(), { repo: "f/g", baseDir: "a/b/c/d/e" }); // 7 段
    expect(p.targetDir).toBe("a/b/c/d/e/f/g");
  });
});

describe("scanRepoMarkers", () => {
  it("扫出所有带标记文件的目录", () => {
    createProfile(deps(), { repo: "o/r1", baseDir: "hf" });
    createProfile(deps(), { repo: "o/r2", baseDir: "qwen3.8" });
    const found = scanRepoMarkers(world.root);
    expect(found.map((f) => f.dir).sort()).toEqual(["hf/o/r1", "qwen3.8/o/r2"]);
  });

  it("普通目录不会被误认为档案", () => {
    touch("main/a.gguf");
    expect(scanRepoMarkers(world.root)).toEqual([]);
  });
});

describe("deleteProfile", () => {
  it("默认只删 DB 行与标记文件，磁盘文件保留", () => {
    const p = createProfile(deps(), { repo: "o/r", baseDir: "hf" });
    touch("hf/o/r/a.gguf");
    deleteProfile(deps(), { id: p.id, deleteFiles: false });
    expect(listProfiles(world.db)).toHaveLength(0);
    expect(existsSync(path.join(world.root, "hf/o/r/a.gguf"))).toBe(true);
    expect(existsSync(path.join(world.root, "hf/o/r", REPO_MARKER_FILENAME))).toBe(false);
  });

  it("deleteFiles 时递归删掉整个目录", () => {
    const p = createProfile(deps(), { repo: "o/r", baseDir: "hf" });
    touch("hf/o/r/a.gguf");
    deleteProfile(deps(), { id: p.id, deleteFiles: true });
    expect(existsSync(path.join(world.root, "hf/o/r"))).toBe(false);
    // 回归锁（任务 H）：rmSync 只准落在面板视角根，宿主视角根全程为空
    expectHostRootEmpty();
  });

  it("目录内文件被模型引用时 deleteFiles 报 LOCKED 并列出配置名", () => {
    const p = createProfile(deps(), { repo: "o/r", baseDir: "hf" });
    touch("hf/o/r/a.gguf");
    addModel({ name: "m1", gguf_file: "hf/o/r/a.gguf" });
    try {
      deleteProfile(deps(), { id: p.id, deleteFiles: true });
      throw new Error("应该抛错");
    } catch (error) {
      expect(error).toBeInstanceOf(RepoProfileError);
      expect((error as RepoProfileError).message).toContain("m1");
    }
  });

  it("不存在的 id 报 NOT_FOUND", () => {
    expect(() => deleteProfile(deps(), { id: 999, deleteFiles: false })).toThrow(/NOT_FOUND/);
  });

  it("有未完成下载任务时报 LOCKED", () => {
    const p = createProfile(deps(), { repo: "o/r", baseDir: "hf" });
    const now = Date.now();
    world.db
      .prepare(
        `INSERT INTO download_tasks
           (batch_id, repo_id, label, kind, source, file, target_rel, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("b1", p.id, "o/r", "file", "hf", "model.gguf", "hf/o/r/model.gguf", "pending", now, now);
    expect(() => deleteProfile(deps(), { id: p.id, deleteFiles: false })).toThrow(/LOCKED/);
  });

  it("有已完成下载记录时删档案不再抛错，且下载记录保留、repo_id 置空", () => {
    const p = createProfile(deps(), { repo: "o/r", baseDir: "hf" });
    const now = Date.now();
    world.db
      .prepare(
        `INSERT INTO download_tasks
           (batch_id, repo_id, label, kind, source, file, target_rel, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("b1", p.id, "o/r", "file", "hf", "model.gguf", "hf/o/r/model.gguf", "done", now, now);
    world.db
      .prepare(
        `INSERT INTO download_history
           (batch_id, repo_id, label, files, total_bytes, status, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("b1", p.id, "o/r", "[]", 100, "done", now);
    touch("hf/o/r/a.gguf");

    expect(() => deleteProfile(deps(), { id: p.id, deleteFiles: true })).not.toThrow();

    expect(existsSync(path.join(world.root, "hf/o/r"))).toBe(false);
    expect(listProfiles(world.db)).toHaveLength(0);
    const task = world.db.prepare("SELECT repo_id FROM download_tasks WHERE batch_id = ?").get("b1") as {
      repo_id: number | null;
    };
    const history = world.db
      .prepare("SELECT repo_id FROM download_history WHERE batch_id = ?")
      .get("b1") as { repo_id: number | null };
    expect(task.repo_id).toBeNull();
    expect(history.repo_id).toBeNull();
  });
});

describe("moveProfile", () => {
  it("整目录搬到新 base，引用同步重写", () => {
    const p = createProfile(deps(), { repo: "o/r", baseDir: "hf" });
    touch("hf/o/r/a.gguf");
    addModel({ name: "m1", gguf_file: "hf/o/r/a.gguf" });
    moveProfile(deps(), { id: p.id, toBaseDir: "qwen3.8" });
    expect(existsSync(path.join(world.root, "qwen3.8/o/r/a.gguf"))).toBe(true);
    expect(world.repo.getModel("m1")?.gguf_file).toBe("qwen3.8/o/r/a.gguf");
    expect(listProfiles(world.db)[0].baseDir).toBe("qwen3.8");
    // 回归锁（任务 H）：moveProfile 经 renameFolder 落盘，同样只准落在面板视角根
    expectHostRootEmpty();
  });

  it("运行中模型引用了目录内文件时报 LOCKED", () => {
    const p = createProfile(deps(), { repo: "o/r", baseDir: "hf" });
    touch("hf/o/r/a.gguf");
    addModel({ name: "m1", gguf_file: "hf/o/r/a.gguf" });
    expect(() => moveProfile(deps("m1"), { id: p.id, toBaseDir: "qwen3.8" })).toThrow(/LOCKED/);
  });

  // 缺陷 2（批 2）：moveProfile 此前没有嵌套判定，可以把档案 A 移进档案 B
  // 的目录内部——scanRepoMarkers 命中 B 的标记后不再往下探，A 从此认领
  // 不回来，B 的 fileCount/local 又会把 A 的文件算成自己的。
  it("moveProfile 把档案移进另一档案目录内部 → 报 CONFLICT，磁盘与 DB 均未变动（缺陷 2 回归锁）", () => {
    const other = createProfile(deps(), { repo: "R2", baseDir: "hf/b" }); // targetDir: hf/b/R2
    const p = createProfile(deps(), { repo: "R1", baseDir: "hf/a" }); // targetDir: hf/a/R1
    touch("hf/a/R1/a.gguf");

    expect(() => moveProfile(deps(), { id: p.id, toBaseDir: other.targetDir })).toThrow(/CONFLICT/);

    // 磁盘上什么都没动：源目录仍在原处，目标位置没有凭空长出新目录
    expect(existsSync(path.join(world.root, "hf/a/R1/a.gguf"))).toBe(true);
    expect(existsSync(path.join(world.root, other.targetDir, "R1"))).toBe(false);
    // DB 里 baseDir 未被改写
    expect(listProfiles(world.db).find((x) => x.id === p.id)?.baseDir).toBe("hf/a");
  });
});

describe("decorateProfileStats", () => {
  const profile: RepoProfile = {
    id: 1,
    repo: "o/r",
    baseDir: "hf",
    targetDir: "hf/o/r",
    createdAt: 0,
  };

  it("目录及子目录内的文件都计入 fileCount/bytes，目录存在时 dirExists 为真", () => {
    const tree: FolderFiles[] = [
      { folder: "hf/o/r", files: [{ rel: "hf/o/r/a.gguf", size: 100, mtime: 0, ino: 1 }] },
      { folder: "hf/o/r/sub", files: [{ rel: "hf/o/r/sub/b.gguf", size: 50, mtime: 0, ino: 2 }] },
      { folder: "other", files: [{ rel: "other/c.gguf", size: 999, mtime: 0, ino: 3 }] },
    ];
    const [stats] = decorateProfileStats([profile], tree);
    expect(stats.fileCount).toBe(2);
    expect(stats.bytes).toBe(150);
    expect(stats.dirExists).toBe(true);
  });

  it("扫盘结果里没有该目录时 dirExists 为假、fileCount/bytes 为 0", () => {
    const [stats] = decorateProfileStats([profile], []);
    expect(stats.fileCount).toBe(0);
    expect(stats.bytes).toBe(0);
    expect(stats.dirExists).toBe(false);
  });

  it("目录存在但为空（scanTree 仍会给一条 files 为空的记录）时 dirExists 为真", () => {
    const tree: FolderFiles[] = [{ folder: "hf/o/r", files: [] }];
    const [stats] = decorateProfileStats([profile], tree);
    expect(stats.fileCount).toBe(0);
    expect(stats.dirExists).toBe(true);
  });

  it("不会把同名前缀但不是子目录的文件夹算进去（hf/o/r-other 不是 hf/o/r 的子目录）", () => {
    const tree: FolderFiles[] = [
      { folder: "hf/o/r-other", files: [{ rel: "hf/o/r-other/x.gguf", size: 10, mtime: 0, ino: 1 }] },
    ];
    const [stats] = decorateProfileStats([profile], tree);
    expect(stats.fileCount).toBe(0);
    expect(stats.dirExists).toBe(false);
  });

  it("硬链接共用的文件只计一次占盘——两个档案各报一次完整大小是误导", () => {
    const profiles = [
      { id: 1, repo: "a/A", baseDir: "hf", targetDir: "hf/a/A", createdAt: 0 },
      { id: 2, repo: "b/B", baseDir: "hf", targetDir: "hf/b/B", createdAt: 0 },
    ];
    // 同一个 inode 出现在两个档案目录下（硬链接），磁盘实际只占 1000
    const tree = [
      { folder: "hf/a/A", files: [{ rel: "hf/a/A/m.gguf", size: 1000, mtime: 0, ino: 42 }] },
      { folder: "hf/b/B", files: [{ rel: "hf/b/B/m.gguf", size: 1000, mtime: 0, ino: 42 }] },
    ];
    const stats = decorateProfileStats(profiles, tree);
    // 每个档案自己看仍是 1000（它确实有这个文件）
    expect(stats[0]!.bytes).toBe(1000);
    expect(stats[1]!.bytes).toBe(1000);
    // 但共用标记要在，供 UI 提示「与 X 共用」
    expect(stats[0]!.sharedBytes).toBe(1000);
    expect(stats[1]!.sharedBytes).toBe(1000);
  });

  it("同一档案内的硬链接只算一次", () => {
    const profiles = [{ id: 1, repo: "a/A", baseDir: "hf", targetDir: "hf/a/A", createdAt: 0 }];
    const tree = [
      {
        folder: "hf/a/A",
        files: [
          { rel: "hf/a/A/m.gguf", size: 1000, mtime: 0, ino: 42 },
          { rel: "hf/a/A/same.gguf", size: 1000, mtime: 0, ino: 42 },
        ],
      },
    ];
    expect(decorateProfileStats(profiles, tree)[0]!.bytes).toBe(1000);
  });
});
