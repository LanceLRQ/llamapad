import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, runMigrations } from "./db";
import { createModelRepo, type ModelRepo } from "./repo/models";
import type { ModelConfig } from "../core/schemas";
import { computeFullHash, computeSampleHash } from "../core/fingerprint";
import {
  clearOrphans,
  computeAndStoreFullHash,
  FileMetaError,
  listFileMeta,
  listFileMetaRows,
  locateCandidates,
  relinkFile,
  setFileMetaFields,
  upsertFileMeta,
} from "./fileMeta";

/**
 * fileMeta 测试（T3a，设计 §3，`docs/_internal/features/
 * 2026-08-28-文件管理与镜像管理-design.md`）。
 */

interface World {
  db: Database.Database;
  repo: ModelRepo;
  root: string;
}

let world: World;

/** 在临时根下写一个指定内容的假文件（父目录自动创建），返回相对路径 */
function touch(rel: string, content: string | Buffer = "x"): string {
  const abs = path.join(world.root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return rel;
}

function addModel(partial: Partial<ModelConfig> & { name: string }): void {
  world.repo.createModel({
    display_name: partial.name,
    namespace: "main",
    gguf_file: "main/a.gguf",
    overrides: {},
    ...partial,
  });
}

beforeEach(() => {
  const db = openDb(":memory:");
  runMigrations(db);
  const root = mkdtempSync(path.join(tmpdir(), "llamapad-filemeta-"));
  world = { db, repo: createModelRepo(db), root };
});

afterEach(() => {
  world.db.close();
  rmSync(world.root, { recursive: true, force: true });
});

describe("upsertFileMeta", () => {
  it("登记单文件：只算采样哈希，full_sha256 为 NULL", async () => {
    touch("main/m1.gguf", "hello-world");
    addModel({ name: "m1", gguf_file: "main/m1.gguf" });

    const entry = await upsertFileMeta(world.db, world.root, "main/m1.gguf");

    expect(entry).not.toBeNull();
    expect(entry!.isGroup).toBe(false);
    expect(entry!.probePath).toBe("main/m1.gguf");
    expect(entry!.sampleSha256).toBe(await computeSampleHash(path.join(world.root, "main/m1.gguf")));
    expect(entry!.fullSha256).toBeNull();
  });

  it("登记分片组：path 为 glob，probe_path 记录首片", async () => {
    touch("main/m1-00001-of-00002.gguf", "part1");
    touch("main/m1-00002-of-00002.gguf", "part2");
    addModel({ name: "m1", gguf_file: "main/m1-*.gguf" });

    const entry = await upsertFileMeta(world.db, world.root, "main/m1-*.gguf");

    expect(entry).not.toBeNull();
    expect(entry!.isGroup).toBe(true);
    expect(entry!.probePath).toBe("main/m1-00001-of-00002.gguf");
    expect(entry!.sampleSha256).toBe(
      await computeSampleHash(path.join(world.root, "main/m1-00001-of-00002.gguf")),
    );
  });

  it("路径探测不到物理文件时返回 null，不落库", async () => {
    const entry = await upsertFileMeta(world.db, world.root, "main/missing.gguf");
    expect(entry).toBeNull();
  });

  it("免费播种：probe_path 命中一条已完成的下载任务时，full_sha256 直接取自 download_tasks.sha256", async () => {
    touch("main/m1.gguf", "downloaded-content");
    addModel({ name: "m1", gguf_file: "main/m1.gguf" });
    world.db
      .prepare(
        `INSERT INTO download_tasks(batch_id, label, kind, source, url, file, target_rel, status, downloaded_bytes, created_at, updated_at)
         VALUES ('b1', 'm1', 'gguf', 'url', 'http://x/m1.gguf', 'm1.gguf', 'main/m1.gguf', 'completed', 10, 1, 1)`,
      )
      .run();
    world.db
      .prepare("UPDATE download_tasks SET sha256 = ? WHERE target_rel = ?")
      .run("a".repeat(64), "main/m1.gguf");

    const entry = await upsertFileMeta(world.db, world.root, "main/m1.gguf");

    expect(entry!.fullSha256).toBe("a".repeat(64));
  });

  it("内容不变（size/mtime 均相同）时缓存命中，重复调用返回同一采样哈希且不清空用户字段", async () => {
    touch("main/m1.gguf", "stable-content");
    addModel({ name: "m1", gguf_file: "main/m1.gguf" });

    const first = await upsertFileMeta(world.db, world.root, "main/m1.gguf");
    setFileMetaFields(world.db, world.root, "main/m1.gguf", { quantLabel: "Q8_0", mark: "备注" });

    const second = await upsertFileMeta(world.db, world.root, "main/m1.gguf");

    expect(second!.sampleSha256).toBe(first!.sampleSha256);
    expect(second!.quantLabel).toBe("Q8_0");
    expect(second!.mark).toBe("备注");
  });

  it("内容变化（改写文件）时重新计算采样哈希，旧 full_sha256 作废", async () => {
    touch("main/m1.gguf", "version-1-content");
    addModel({ name: "m1", gguf_file: "main/m1.gguf" });
    const first = await upsertFileMeta(world.db, world.root, "main/m1.gguf");

    // 手动补一次完整哈希，模拟"曾经算过"
    await computeAndStoreFullHash(world.db, world.root, "main/m1.gguf");

    // 改写内容（不同长度，size 必变）
    touch("main/m1.gguf", "version-2-content-longer-than-before");
    const second = await upsertFileMeta(world.db, world.root, "main/m1.gguf");

    expect(second!.sampleSha256).not.toBe(first!.sampleSha256);
    expect(second!.fullSha256).toBeNull(); // 旧值作废，未重新点「计算校验和」前留空
  });
});

describe("listFileMeta", () => {
  it("列出全部当前引用的文件，并标记孤儿（meta 有、磁盘无）", async () => {
    touch("main/m1.gguf");
    touch("main/m2.gguf");
    addModel({ name: "m1", gguf_file: "main/m1.gguf" });
    addModel({ name: "m2", gguf_file: "main/m2.gguf" });

    await listFileMeta(world.db, world.root); // 首次登记两行

    unlinkSync(path.join(world.root, "main/m2.gguf")); // 磁盘上消失，但 meta 行还在

    const entries = await listFileMeta(world.db, world.root);
    const byPath = new Map(entries.map((e) => [e.path, e]));
    expect(byPath.get("main/m1.gguf")?.isOrphan).toBe(false);
    expect(byPath.get("main/m2.gguf")?.isOrphan).toBe(true);
  });

  it("也登记游离文件——L2 算出的哈希要有地方缓存", async () => {
    touch("loose/orphan.gguf", "x".repeat(100));
    // 不建任何引用 loose/orphan.gguf 的模型配置

    const entries = await listFileMeta(world.db, world.root);
    const loose = entries.find((e) => e.path === "loose/orphan.gguf");
    expect(loose).toBeDefined();
    expect(loose!.sampleSha256).not.toBeNull();
    expect(loose!.isOrphan).toBe(false);
  });

  it("models 根之外的 gguf 不登记——扫描范围就是根内，别处的文件不该被认领", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "llamapad-outside-"));
    writeFileSync(path.join(outside, "outside-only.gguf"), "x".repeat(100));
    try {
      const entries = await listFileMeta(world.db, world.root);
      expect(entries.some((e) => e.path.includes("outside-only.gguf"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("游离分片组按物理文件逐行登记，不合并成 glob", async () => {
    touch("loose/big-00001-of-00002.gguf", "x".repeat(100));
    touch("loose/big-00002-of-00002.gguf", "y".repeat(100));

    const entries = await listFileMeta(world.db, world.root);
    const paths = entries.map((e) => e.path).filter((p) => p.includes("big-"));
    expect(paths.sort()).toEqual(["loose/big-00001-of-00002.gguf", "loose/big-00002-of-00002.gguf"]);
  });
});

describe("listFileMetaRows", () => {
  it("只读整表快照：不触发登记、不扫盘——scan API 复用缓存哈希用，不该把 models 树重新扫一遍", async () => {
    touch("main/m1.gguf");
    addModel({ name: "m1", gguf_file: "main/m1.gguf" });
    await listFileMeta(world.db, world.root); // 先正常登记一行，带出非空 full_sha256

    await computeAndStoreFullHash(world.db, world.root, "main/m1.gguf");

    touch("loose/未登记.gguf"); // 磁盘上新增一个从未被 listFileMeta 处理过的游离文件

    const rows = listFileMetaRows(world.db);
    expect(rows).toEqual([
      { path: "main/m1.gguf", fullSha256: expect.any(String), quantLabel: null, mark: null },
    ]);
    // 断言它确实没有静默帮我扫盘登记——否则上面的新文件会跟着冒出来
    expect(rows.some((r) => r.path.includes("未登记"))).toBe(false);
  });

  it("quantLabel/mark 随表带出（任务 18：unclaimed-view 的 hasMeta 判定要用这两列区分\"有行\"与\"有标注\"）", async () => {
    touch("main/m1.gguf");
    addModel({ name: "m1", gguf_file: "main/m1.gguf" });
    await listFileMeta(world.db, world.root);
    await setFileMetaFields(world.db, world.root, "main/m1.gguf", { quantLabel: "Q4_K_M", mark: "备注" });

    const rows = listFileMetaRows(world.db);
    expect(rows).toEqual([
      { path: "main/m1.gguf", fullSha256: null, quantLabel: "Q4_K_M", mark: "备注" },
    ]);
  });

  it("未登记任何文件时返回空数组", () => {
    expect(listFileMetaRows(world.db)).toEqual([]);
  });
});

describe("setFileMetaFields", () => {
  it("编辑 quant_label / mark", async () => {
    touch("main/m1.gguf");
    addModel({ name: "m1", gguf_file: "main/m1.gguf" });
    await upsertFileMeta(world.db, world.root, "main/m1.gguf");

    const updated = setFileMetaFields(world.db, world.root, "main/m1.gguf", {
      quantLabel: "Q4_K_M",
      mark: "手动放入的老文件",
    });

    expect(updated.quantLabel).toBe("Q4_K_M");
    expect(updated.mark).toBe("手动放入的老文件");
  });

  it("显式传 null 清空字段", async () => {
    touch("main/m1.gguf");
    addModel({ name: "m1", gguf_file: "main/m1.gguf" });
    await upsertFileMeta(world.db, world.root, "main/m1.gguf");
    setFileMetaFields(world.db, world.root, "main/m1.gguf", { quantLabel: "Q4_K_M" });

    const cleared = setFileMetaFields(world.db, world.root, "main/m1.gguf", { quantLabel: null });

    expect(cleared.quantLabel).toBeNull();
  });

  it("条目不存在时抛 NOT_FOUND", () => {
    expect(() => setFileMetaFields(world.db, world.root, "main/ghost.gguf", { mark: "x" })).toThrow(
      FileMetaError,
    );
  });
});

describe("locateCandidates", () => {
  it("采样命中 + 完整哈希一致 → 判定为同一文件", async () => {
    touch("main/m1.gguf", "same-content");
    addModel({ name: "m1", gguf_file: "main/m1.gguf" });
    await upsertFileMeta(world.db, world.root, "main/m1.gguf");
    await computeAndStoreFullHash(world.db, world.root, "main/m1.gguf");

    // 文件被搬到别处、未被任何配置引用（candidate）
    touch("lab/relocated.gguf", "same-content");

    const candidates = await locateCandidates(world.db, world.root, "main/m1.gguf");

    expect(candidates).toHaveLength(1);
    expect(candidates[0].nextValue).toBe("lab/relocated.gguf");
    expect(candidates[0].fullSha256).toBe(
      await computeFullHash(path.join(world.root, "lab/relocated.gguf")),
    );
  });

  it("采样命中但完整哈希不一致 → 丢弃该候选（采样碰撞）", async () => {
    touch("main/m1.gguf", "content-a");
    addModel({ name: "m1", gguf_file: "main/m1.gguf" });
    await upsertFileMeta(world.db, world.root, "main/m1.gguf");
    await computeAndStoreFullHash(world.db, world.root, "main/m1.gguf");

    // 手动伪造一次"采样碰撞"：直接改库里的 sample_sha256，让候选文件的采样值凑巧命中，
    // 但完整内容其实不同
    touch("lab/collide.gguf", "content-b-different-full-hash");
    const collideSample = await computeSampleHash(path.join(world.root, "lab/collide.gguf"));
    world.db
      .prepare("UPDATE file_meta SET sample_sha256 = ? WHERE path = ?")
      .run(collideSample, "main/m1.gguf");

    const candidates = await locateCandidates(world.db, world.root, "main/m1.gguf");

    expect(candidates).toHaveLength(0);
  });

  it("条目 full_sha256 为 NULL 时，采样命中即视为确认（首次建立基线）", async () => {
    touch("main/m1.gguf", "bootstrap-content");
    addModel({ name: "m1", gguf_file: "main/m1.gguf" });
    await upsertFileMeta(world.db, world.root, "main/m1.gguf"); // full_sha256 留空

    touch("lab/relocated.gguf", "bootstrap-content");

    const candidates = await locateCandidates(world.db, world.root, "main/m1.gguf");

    expect(candidates).toHaveLength(1);
    expect(candidates[0].fullSha256).toHaveLength(64); // 现算并可供 relink 回填
  });

  it("候选集排除已被配置引用的文件", async () => {
    touch("main/m1.gguf", "shared-content");
    touch("main/m2.gguf", "shared-content"); // 同内容但已被 m2 引用，不该出现在候选里
    addModel({ name: "m1", gguf_file: "main/m1.gguf" });
    addModel({ name: "m2", gguf_file: "main/m2.gguf" });
    await upsertFileMeta(world.db, world.root, "main/m1.gguf");

    const candidates = await locateCandidates(world.db, world.root, "main/m1.gguf");

    expect(candidates).toHaveLength(0);
  });

  it("分片组候选按首片去重：同组其余分片不会各自成为候选", async () => {
    touch("main/m1-00001-of-00002.gguf", "part1");
    touch("main/m1-00002-of-00002.gguf", "part2");
    addModel({ name: "m1", gguf_file: "main/m1-*.gguf" });
    await upsertFileMeta(world.db, world.root, "main/m1-*.gguf");
    await computeAndStoreFullHash(world.db, world.root, "main/m1-*.gguf");

    touch("lab/m1-00001-of-00002.gguf", "part1");
    touch("lab/m1-00002-of-00002.gguf", "part2");

    const candidates = await locateCandidates(world.db, world.root, "main/m1-*.gguf");

    expect(candidates).toHaveLength(1);
    expect(candidates[0].probePath).toBe("lab/m1-00001-of-00002.gguf");
    expect(candidates[0].nextValue).toBe("lab/m1-*.gguf");
  });

  it("条目不存在时抛 NOT_FOUND", async () => {
    await expect(locateCandidates(world.db, world.root, "main/ghost.gguf")).rejects.toThrow(
      FileMetaError,
    );
  });
});

describe("relinkFile", () => {
  it("重链后更新引用它的模型配置 + file_meta.path/probe_path", async () => {
    touch("main/m1.gguf", "content");
    addModel({ name: "m1", gguf_file: "main/m1.gguf" });
    await upsertFileMeta(world.db, world.root, "main/m1.gguf");
    touch("lab/relocated.gguf", "content");

    const updated = relinkFile(world.db, world.root, "main/m1.gguf", "lab/relocated.gguf");

    expect(updated.path).toBe("lab/relocated.gguf");
    expect(updated.probePath).toBe("lab/relocated.gguf");
    expect(world.repo.getModel("m1")?.gguf_file).toBe("lab/relocated.gguf");
    expect(existsSync(path.join(world.root, "lab/relocated.gguf"))).toBe(true); // 物理文件未被移动
  });

  it("一个文件被多个模型引用：重链后全部模型配置一起更新", async () => {
    touch("main/shared.gguf", "content");
    addModel({ name: "m1", gguf_file: "main/a.gguf", mmproj_file: "main/shared.gguf" });
    addModel({ name: "m2", gguf_file: "main/b.gguf", mmproj_file: "main/shared.gguf" });
    await upsertFileMeta(world.db, world.root, "main/shared.gguf");
    touch("lab/shared.gguf", "content");

    relinkFile(world.db, world.root, "main/shared.gguf", "lab/shared.gguf");

    expect(world.repo.getModel("m1")?.mmproj_file).toBe("lab/shared.gguf");
    expect(world.repo.getModel("m2")?.mmproj_file).toBe("lab/shared.gguf");
  });

  it("候选路径不存在时抛 INVALID_VALUE", async () => {
    touch("main/m1.gguf", "content");
    addModel({ name: "m1", gguf_file: "main/m1.gguf" });
    await upsertFileMeta(world.db, world.root, "main/m1.gguf");

    expect(() => relinkFile(world.db, world.root, "main/m1.gguf", "lab/ghost.gguf")).toThrow(
      FileMetaError,
    );
  });

  it("条目不存在时抛 NOT_FOUND", () => {
    expect(() => relinkFile(world.db, world.root, "main/ghost.gguf", "lab/x.gguf")).toThrow(
      FileMetaError,
    );
  });
});

describe("computeAndStoreFullHash", () => {
  it("计算并落库完整哈希", async () => {
    touch("main/m1.gguf", "full-hash-content");
    addModel({ name: "m1", gguf_file: "main/m1.gguf" });
    await upsertFileMeta(world.db, world.root, "main/m1.gguf");

    const hash = await computeAndStoreFullHash(world.db, world.root, "main/m1.gguf");

    expect(hash).toHaveLength(64);
    const entries = await listFileMeta(world.db, world.root);
    expect(entries.find((e) => e.path === "main/m1.gguf")?.fullSha256).toBe(hash);
  });

  it("物理文件已不存在时抛 NOT_FOUND", async () => {
    touch("main/m1.gguf", "x");
    addModel({ name: "m1", gguf_file: "main/m1.gguf" });
    await upsertFileMeta(world.db, world.root, "main/m1.gguf");
    unlinkSync(path.join(world.root, "main/m1.gguf"));

    await expect(computeAndStoreFullHash(world.db, world.root, "main/m1.gguf")).rejects.toThrow(
      FileMetaError,
    );
  });
});

describe("migration v8：file_meta 建表", () => {
  it("全新库迁移后 file_meta 列齐、既有表不受影响", () => {
    const cols = (
      world.db.prepare("PRAGMA table_info(file_meta)").all() as { name: string }[]
    ).map((r) => r.name);
    const expected = [
      "id", "path", "is_group", "probe_path", "size", "mtime",
      "sample_sha256", "full_sha256", "quant_label", "mark", "created_at", "updated_at",
    ];
    expect([...cols].sort()).toEqual([...expected].sort());
    expect(cols).toHaveLength(expected.length);

    const tables = (
      world.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name);
    for (const t of ["namespaces", "models", "settings", "download_tasks", "runs", "gguf_meta"]) {
      expect(tables).toContain(t); // 既有迁移未被改动
    }
  });

  it("path 唯一约束：重复 path 插入被拒绝", () => {
    world.db
      .prepare(
        `INSERT INTO file_meta(path, is_group, probe_path, created_at, updated_at)
         VALUES ('main/x.gguf', 0, 'main/x.gguf', 1, 1)`,
      )
      .run();
    expect(() =>
      world.db
        .prepare(
          `INSERT INTO file_meta(path, is_group, probe_path, created_at, updated_at)
           VALUES ('main/x.gguf', 0, 'main/x.gguf', 2, 2)`,
        )
        .run(),
    ).toThrow();
  });
});

describe("clearOrphans", () => {
  it("清理 meta 有、磁盘无的记录，保留正常记录", async () => {
    touch("main/m1.gguf");
    touch("main/m2.gguf");
    addModel({ name: "m1", gguf_file: "main/m1.gguf" });
    addModel({ name: "m2", gguf_file: "main/m2.gguf" });
    await listFileMeta(world.db, world.root);
    unlinkSync(path.join(world.root, "main/m2.gguf"));

    const deleted = clearOrphans(world.db, world.root);

    expect(deleted).toBe(1);
    const remaining = world.db.prepare("SELECT path FROM file_meta").all() as { path: string }[];
    expect(remaining.map((r) => r.path)).toEqual(["main/m1.gguf"]);
  });

  it("没有孤儿时返回 0", async () => {
    touch("main/m1.gguf");
    addModel({ name: "m1", gguf_file: "main/m1.gguf" });
    await upsertFileMeta(world.db, world.root, "main/m1.gguf");

    expect(clearOrphans(world.db, world.root)).toBe(0);
  });
});
