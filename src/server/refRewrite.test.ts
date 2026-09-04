import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, runMigrations } from "./db";
import { createModelRepo, type ModelRepo } from "./repo/models";
import type { ModelConfig } from "../core/schemas";
import { upsertFileMeta } from "./fileMeta";
import { rewriteFileRefs, RefRewriteError } from "./refRewrite";

/**
 * rewriteFileRefs 测试（本地权重迁移，任务 11）
 *
 * 搭建与 filesApi.test.ts / fileMeta.test.ts 同款：:memory: 库 + tmp models 根。
 * rewriteFileRefs 本身是纯 DB 操作（不碰文件系统），但 file_meta 的登记
 * （upsertFileMeta）需要磁盘上真有文件才能算哈希，所以夹具仍然建了临时根。
 */

interface World {
  db: Database.Database;
  repo: ModelRepo;
  root: string;
}

let world: World;

/** 在临时根下写一个文件（父目录自动创建） */
function touch(rel: string, content = "content"): void {
  const abs = path.join(world.root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** 建模型（display_name/namespace/overrides 缺省取最小合法值） */
function addModel(partial: Partial<ModelConfig> & { name: string }): void {
  world.repo.createModel({
    display_name: partial.name,
    namespace: "main",
    gguf_file: "main/a.gguf",
    overrides: {},
    ...partial,
  });
}

/** 登记一条 file_meta：先在磁盘上落一份同名文件（upsertFileMeta 要读盘算哈希） */
async function upsertMetaRow(rel: string): Promise<void> {
  touch(rel);
  await upsertFileMeta(world.db, world.root, rel);
}

function metaPaths(): string[] {
  return (world.db.prepare("SELECT path FROM file_meta").all() as { path: string }[]).map(
    (r) => r.path,
  );
}

beforeEach(() => {
  const db = openDb(":memory:");
  runMigrations(db);
  const root = mkdtempSync(path.join(tmpdir(), "llamapad-refrewrite-"));
  world = { db, repo: createModelRepo(db), root };
});

afterEach(() => {
  world.db.close();
  rmSync(world.root, { recursive: true, force: true });
});

describe("rewriteFileRefs", () => {
  it("精确路径引用：改指到新路径，file_meta 一并迁移", async () => {
    addModel({ name: "m1", gguf_file: "loose/a.gguf" });
    await upsertMetaRow("loose/a.gguf");

    const n = rewriteFileRefs(world.db, "loose/a.gguf", "hf/u/r/a.gguf");

    expect(n).toBe(1);
    expect(world.repo.getModel("m1")?.gguf_file).toBe("hf/u/r/a.gguf");
    expect(metaPaths()).toContain("hf/u/r/a.gguf");
    expect(metaPaths()).not.toContain("loose/a.gguf");
  });

  it("多个模型引用同一文件：全部改指", () => {
    addModel({ name: "m1", gguf_file: "loose/a.gguf" });
    addModel({ name: "m2", mmproj_file: "loose/a.gguf" });

    expect(rewriteFileRefs(world.db, "loose/a.gguf", "hf/u/r/a.gguf")).toBe(2);

    expect(world.repo.getModel("m1")?.gguf_file).toBe("hf/u/r/a.gguf");
    expect(world.repo.getModel("m2")?.mmproj_file).toBe("hf/u/r/a.gguf");
  });

  it("glob 引用命中 fromRel：抛 RefRewriteError，一个配置都不改", () => {
    addModel({ name: "m1", gguf_file: "loose/a-*.gguf" });

    expect(() =>
      rewriteFileRefs(world.db, "loose/a-00001-of-00002.gguf", "hf/u/r/x.gguf"),
    ).toThrow(RefRewriteError);
    expect(world.repo.getModel("m1")?.gguf_file).toBe("loose/a-*.gguf");
  });

  it("glob 引用但字面上不命中 fromRel：不受影响，正常改写", () => {
    // 库里存在一个完全无关的分片组 glob，不该因为它的存在就把无关文件的
    // 单文件迁移也拦下——物理文件已经搬走，没法靠读盘展开来判断"是否命中"，
    // 必须靠纯字符串匹配把这类误伤排除掉
    addModel({ name: "unrelated", gguf_file: "other/b-*.gguf" });
    addModel({ name: "m1", gguf_file: "loose/a.gguf" });

    const n = rewriteFileRefs(world.db, "loose/a.gguf", "hf/u/r/a.gguf");

    expect(n).toBe(1);
    expect(world.repo.getModel("m1")?.gguf_file).toBe("hf/u/r/a.gguf");
    expect(world.repo.getModel("unrelated")?.gguf_file).toBe("other/b-*.gguf");
  });

  it("没有任何引用：返回 0，不抛错", () => {
    expect(rewriteFileRefs(world.db, "loose/orphan.gguf", "hf/u/r/orphan.gguf")).toBe(0);
  });

  it("目标路径已有一条孤儿 file_meta 行：先腾位置再迁移，不撞 UNIQUE 约束", async () => {
    // 模拟 hf/u/r/a.gguf 这个落点此前有过一条与当前文件无关的死记录
    // （比如上一次迁移遗留、或运维手动 mv 过），rewriteFileRefs 不能因此崩溃
    addModel({ name: "m1", gguf_file: "loose/a.gguf" });
    await upsertMetaRow("loose/a.gguf");
    await upsertMetaRow("hf/u/r/a.gguf");

    expect(() => rewriteFileRefs(world.db, "loose/a.gguf", "hf/u/r/a.gguf")).not.toThrow();
    expect(metaPaths().filter((p) => p === "hf/u/r/a.gguf")).toHaveLength(1);
    expect(metaPaths()).not.toContain("loose/a.gguf");
  });
});
