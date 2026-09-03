import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { openDb, runMigrations } from "../db";
import {
  DownloadError,
  type DownloadHandle,
  type DownloadRequest,
  type DownloadResult,
  type ProgressInfo,
} from "./downloader";
import { createDownloadManager, type DownloadManager, type EnqueueDownloadArgs } from "./manager";

/** 走一轮宏任务（manager 的完成回调链全部在微任务里，setTimeout(0) 足够铺开） */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** 直查任务行（绕开被测的 listTasks，断言落库真值） */
interface TaskRow {
  id: number;
  batch_id: string;
  repo_id: number | null;
  label: string;
  kind: string;
  source: string;
  repo: string | null;
  url: string | null;
  file: string;
  target_rel: string;
  shard_index: number | null;
  shard_total: number | null;
  expected_size: number | null;
  sha256: string | null;
  status: string;
  downloaded_bytes: number;
  error: string | null;
  created_at: number;
  updated_at: number;
  source_path: string | null;
  local_action: string | null;
}

interface HistoryRow {
  id: number;
  batch_id: string;
  repo_id: number | null;
  label: string;
  files: string;
  total_bytes: number;
  status: string;
  finished_at: number;
}

interface EventRow {
  ts: number;
  kind: string;
  message: string;
}

// ---------- 可控 mock 下载器 ----------

interface MockHandle extends DownloadHandle {
  /** 让 result 以成功收尾 */
  resolveWith(r: DownloadResult): void;
  /** 让 result 以失败 reject */
  rejectWith(e: unknown): void;
}

interface MockCall {
  req: DownloadRequest;
  progress: (p: ProgressInfo) => void;
}

function mockDownloader(opts: { throwSyncFor?: (req: DownloadRequest) => boolean } = {}) {
  const calls: MockCall[] = [];
  const handles: MockHandle[] = [];
  const fn = vi.fn((req: DownloadRequest, onProgress?: (p: ProgressInfo) => void) => {
    // 复现「请求组装 / 下载器同步启动失败」路径：命中的请求不建句柄，直接同步抛错
    if (opts.throwSyncFor?.(req)) {
      throw new DownloadError("NETWORK_ERROR", "同步启动失败: boom");
    }
    let res!: (r: DownloadResult) => void;
    let rej!: (e: unknown) => void;
    const result = new Promise<DownloadResult>((resolve, reject) => {
      res = resolve;
      rej = reject;
    });
    const handle: MockHandle = {
      pause: vi.fn(() => rej(new DownloadError("PAUSED", "下载已暂停"))),
      cancel: vi.fn(async () => {
        rej(new DownloadError("CANCELED", "下载已取消"));
      }),
      result,
      resolveWith: (r) => res(r),
      rejectWith: (e) => rej(e),
    };
    calls.push({ req, progress: onProgress ?? (() => {}) });
    handles.push(handle);
    return handle;
  });
  return { calls, handles, fn };
}

type MockDl = ReturnType<typeof mockDownloader>;

// ---------- 夹具 ----------

function makeDb(): Database.Database {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}

function makeManager(
  db: Database.Database,
  modelsRoot: string,
  dl = mockDownloader(),
  progressIntervalMs = 0,
): { manager: DownloadManager; dl: MockDl } {
  const manager = createDownloadManager(db, {
    downloader: dl.fn as typeof import("./downloader").startDownload,
    modelsRoot,
    progressIntervalMs,
  });
  return { manager, dl };
}

/** repo_id 是 model_repos 的外键（openDb 开了 foreign_keys），传 id 前得先有档案 */
function seedRepo(db: Database.Database, repo = "Qwen/Qwen3-8B-GGUF", baseDir = "main"): number {
  const info = db
    .prepare("INSERT INTO model_repos(repo, base_dir, created_at) VALUES (?, ?, ?)")
    .run(repo, baseDir, Date.now());
  return Number(info.lastInsertRowid);
}

const SHARD1 = "Qwen3-8B-Q4_K_M-00001-of-00002.gguf";
const SHARD2 = "Qwen3-8B-Q4_K_M-00002-of-00002.gguf";
const MMPROJ = "mmproj-Qwen3-8B-F16.gguf";

const REPO = "Qwen/Qwen3-8B-GGUF";

/** hf 档案入队参数：默认单文件落 main/，各用例按需覆盖 */
function hfArgs(partial: Partial<EnqueueDownloadArgs> = {}): EnqueueDownloadArgs {
  return {
    files: [{ file: SHARD1 }],
    targetDir: "main",
    source: "hf",
    repo: REPO,
    label: REPO,
    ...partial,
  };
}

function taskRows(db: Database.Database): TaskRow[] {
  return db.prepare("SELECT * FROM download_tasks ORDER BY id").all() as TaskRow[];
}

function taskRow(db: Database.Database, id: number): TaskRow {
  return db.prepare("SELECT * FROM download_tasks WHERE id = ?").get(id) as TaskRow;
}

function historyRows(db: Database.Database): HistoryRow[] {
  return db.prepare("SELECT * FROM download_history ORDER BY id").all() as HistoryRow[];
}

function events(db: Database.Database): EventRow[] {
  return db.prepare("SELECT ts, kind, message FROM events ORDER BY id").all() as EventRow[];
}

let root: string;

/** 在 models 根下写出指定大小的目标文件（「已存在则跳过」判定的前置条件） */
function writeTargetFile(rel: string, size: number): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, Buffer.alloc(size));
}

/** 推进当前活动任务到完成（按其 expectedSize 落总量），返回时队列已接棒 */
async function runOneTask(dl: MockDl): Promise<void> {
  const i = dl.handles.length - 1;
  if (i < 0) return;
  dl.handles[i].resolveWith({
    ok: true,
    bytes: dl.calls[i].req.expectedSize ?? 0,
    sha256Verified: "skipped",
    resumedFrom: 0,
  });
  await flush();
}

/** 反复推进直到队列跑空（批次归档断言要整批完成）；上限只是防止用例写错挂死 */
async function runQueueToCompletion(manager: DownloadManager, dl: MockDl): Promise<void> {
  for (let guard = 0; manager.getQueueHead() !== null && guard < 100; guard++) {
    await runOneTask(dl);
  }
}

/**
 * local 任务走真实文件 I/O（不经过被 mock 的 downloader），flush() 那单个宏任务
 * 不够用；轮询到队列空闲为止，超时只是防止用例写错挂死。
 */
async function waitQueueIdle(manager: DownloadManager, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (manager.getQueueHead() !== null) {
    if (Date.now() > deadline) throw new Error("等待本地任务完成超时");
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "llamapad-mgr-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------- 1. enqueue：任务行 / 事件 / 磁盘预检 ----------

describe("enqueueDownload", () => {
  it("每文件生成任务行（batch_id/repo_id/label/kind/shard/target_rel），events 记 download.enqueue，返回 id 列表，并自动启动首个任务", async () => {
    const db = makeDb();
    const repoId = seedRepo(db);
    const { manager, dl } = makeManager(db, root);

    const { taskIds, batchId, skipped } = await manager.enqueueDownload(
      hfArgs({
        repoId,
        files: [
          { file: SHARD1, size: 100 },
          { file: SHARD2, size: 100 },
          { file: MMPROJ, size: 10, sha256: "a".repeat(64) },
        ],
      }),
    );

    expect(taskIds).toHaveLength(3);
    expect(skipped).toEqual([]);
    const rows = taskRows(db);
    expect(rows.map((r) => r.status)).toEqual(["downloading", "pending", "pending"]);
    // 同批任务共享 batch_id：归档与展示都以它为单元
    expect(rows.every((r) => r.batch_id === batchId)).toBe(true);
    expect(rows[0]).toMatchObject({
      repo_id: repoId,
      label: REPO,
      kind: "gguf",
      source: "hf",
      repo: REPO,
      file: SHARD1,
      target_rel: `main/${SHARD1}`,
      shard_index: 1,
      shard_total: 2,
      expected_size: 100,
      status: "downloading",
    });
    expect(rows[1]).toMatchObject({ shard_index: 2, shard_total: 2 });
    expect(rows[2]).toMatchObject({ kind: "mmproj", shard_index: null, sha256: "a".repeat(64) });

    // 自动开始第一个：请求 URL 按 hf 官方端点拼装，targetPath 落 modelsRoot/target_rel
    expect(dl.calls).toHaveLength(1);
    expect(dl.calls[0].req.url).toBe(`https://huggingface.co/${REPO}/resolve/main/${SHARD1}`);
    expect(dl.calls[0].req.targetPath).toBe(path.join(root, "main", SHARD1));
    expect(dl.calls[0].req.expectedSize).toBe(100);

    const enqueueEvents = events(db).filter((e) => e.kind === "download.enqueue");
    expect(enqueueEvents).toHaveLength(1);
    expect(enqueueEvents[0].message).toContain(REPO);
    expect(enqueueEvents[0].message).toContain("3");
  });

  it("repoId 不传时 repo_id 落 NULL（URL 直链没有档案可挂）", async () => {
    const db = makeDb();
    const { manager } = makeManager(db, root);
    await manager.enqueueDownload(hfArgs());
    expect(taskRows(db)[0].repo_id).toBeNull();
  });

  it("targetDir 决定落盘目录（target_rel 前缀）", async () => {
    const db = makeDb();
    const { manager } = makeManager(db, root);
    await manager.enqueueDownload(hfArgs({ targetDir: "exp" }));
    expect(taskRows(db)[0].target_rel).toBe(`exp/${SHARD1}`);
  });

  it("targetDir 为空串时落 models 根，不拼前导 /", async () => {
    const db = makeDb();
    const { manager, dl } = makeManager(db, root);
    await manager.enqueueDownload(hfArgs({ targetDir: "" }));
    expect(taskRows(db)[0].target_rel).toBe(SHARD1);
    expect(dl.calls[0].req.targetPath).toBe(path.join(root, SHARD1));
  });

  it("targetDir 路径安全校验：拒绝绝对路径 / .. 段 / 空段", async () => {
    const db = makeDb();
    const { manager } = makeManager(db, root);
    await expect(manager.enqueueDownload(hfArgs({ targetDir: "/etc" }))).rejects.toThrow(/非法/);
    await expect(manager.enqueueDownload(hfArgs({ targetDir: "../escape" }))).rejects.toThrow(
      /非法/,
    );
    await expect(manager.enqueueDownload(hfArgs({ targetDir: "a//b" }))).rejects.toThrow(/非法/);
    expect(taskRows(db)).toHaveLength(0);
  });

  it("磁盘预检：组总大小超过剩余空间时抛错且不入队、不启动", async () => {
    const db = makeDb();
    const { manager, dl } = makeManager(db, root);
    await expect(
      manager.enqueueDownload(hfArgs({ files: [{ file: SHARD1, size: Number.MAX_SAFE_INTEGER }] })),
    ).rejects.toThrow(/磁盘空间不足/);
    expect(taskRows(db)).toHaveLength(0);
    expect(dl.calls).toHaveLength(0);
  });

  it("文件列表为空 / 路径含 .. 时拒绝", async () => {
    const db = makeDb();
    const { manager } = makeManager(db, root);
    await expect(manager.enqueueDownload(hfArgs({ files: [] }))).rejects.toThrow(/至少一个文件/);
    await expect(
      manager.enqueueDownload(hfArgs({ files: [{ file: "../escape.gguf" }] })),
    ).rejects.toThrow(/非法/);
  });

  it("url 直链来源：请求 url 取入参 url，repo 为空", async () => {
    const db = makeDb();
    const { manager, dl } = makeManager(db, root);
    await manager.enqueueDownload(
      hfArgs({
        source: "url",
        repo: undefined,
        url: "https://example.com/model.gguf",
        label: "example.com",
        files: [{ file: "model.gguf" }],
      }),
    );
    expect(dl.calls[0].req.url).toBe("https://example.com/model.gguf");
    expect(taskRows(db)[0]).toMatchObject({
      source: "url",
      url: "https://example.com/model.gguf",
      repo: null,
      label: "example.com",
    });
  });
});

// ---------- 1a2. source 与 repo/url 的搭配守卫 ----------

describe("enqueueDownload 来源参数搭配", () => {
  it("source 为 hf 却不给 repo 时拒绝入队，不静默拼出含 null 的下载地址", async () => {
    const db = makeDb();
    const { manager } = makeManager(db, root);

    await expect(
      manager.enqueueDownload({
        files: [{ file: "a.gguf", size: 10 }],
        targetDir: "hf/o/r",
        source: "hf",
        label: "o/r",
      }),
    ).rejects.toThrow(/source 为 hf 时必须提供 repo/);
    expect(taskRows(db)).toHaveLength(0);
  });

  it("source 为 url 却不给 url 时拒绝入队", async () => {
    const db = makeDb();
    const { manager } = makeManager(db, root);

    await expect(
      manager.enqueueDownload({
        files: [{ file: "a.gguf", size: 10 }],
        targetDir: "main",
        source: "url",
        label: "example.com",
      }),
    ).rejects.toThrow(/source 为 url 时必须提供 url/);
    expect(taskRows(db)).toHaveLength(0);
  });
});

// ---------- 1b. 目标文件已存在则跳过（mmproj 跨量化共用） ----------

describe("enqueueDownload 已存在文件跳过", () => {
  it("目标文件已存在且大小匹配时跳过，不入队", async () => {
    const db = makeDb();
    const { manager } = makeManager(db, root);
    writeTargetFile("hf/o/r/mmproj-F16.gguf", 1024);

    const result = await manager.enqueueDownload({
      files: [{ file: "mmproj-F16.gguf", size: 1024 }],
      targetDir: "hf/o/r",
      source: "hf",
      repo: "o/r",
      label: "o/r",
    });

    expect(result.taskIds).toHaveLength(0);
    expect(result.skipped).toEqual(["mmproj-F16.gguf"]);
    expect(taskRows(db)).toHaveLength(0);
  });

  it("文件存在但大小不符时照常下载——那是残缺文件", async () => {
    const db = makeDb();
    const { manager } = makeManager(db, root);
    writeTargetFile("hf/o/r/a.gguf", 512);

    const result = await manager.enqueueDownload({
      files: [{ file: "a.gguf", size: 1024 }],
      targetDir: "hf/o/r",
      source: "hf",
      repo: "o/r",
      label: "o/r",
    });

    expect(result.taskIds).toHaveLength(1);
    expect(result.skipped).toEqual([]);
  });

  it("expected_size 未知时保守下载，不跳过", async () => {
    const db = makeDb();
    const { manager } = makeManager(db, root);
    writeTargetFile("hf/o/r/b.gguf", 512);

    const result = await manager.enqueueDownload({
      files: [{ file: "b.gguf" }],
      targetDir: "hf/o/r",
      source: "hf",
      repo: "o/r",
      label: "o/r",
    });

    expect(result.taskIds).toHaveLength(1);
  });

  it("同批里只跳过已存在的那个，其余照常入队", async () => {
    const db = makeDb();
    const { manager } = makeManager(db, root);
    writeTargetFile("hf/o/r/mmproj-F16.gguf", 1024);

    const result = await manager.enqueueDownload({
      files: [
        { file: "mmproj-F16.gguf", size: 1024 },
        { file: "main.gguf", size: 2048 },
      ],
      targetDir: "hf/o/r",
      source: "hf",
      repo: "o/r",
      label: "o/r",
    });

    expect(result.skipped).toEqual(["mmproj-F16.gguf"]);
    expect(result.taskIds).toHaveLength(1);
    expect(taskRows(db).map((r) => r.file)).toEqual(["main.gguf"]);
    const enqueued = events(db).filter((e) => e.kind === "download.enqueue");
    expect(enqueued[0].message).toContain("跳过 1 个已存在文件");
  });

  it("全部跳过时不 kick 队列", async () => {
    const db = makeDb();
    const { manager, dl } = makeManager(db, root);
    writeTargetFile("hf/o/r/c.gguf", 100);

    const result = await manager.enqueueDownload({
      files: [{ file: "c.gguf", size: 100 }],
      targetDir: "hf/o/r",
      source: "hf",
      repo: "o/r",
      label: "o/r",
    });

    expect(result.taskIds).toHaveLength(0);
    expect(manager.getQueueHead()).toBeNull();
    expect(dl.calls).toHaveLength(0);
  });
});

// ---------- 2/4. 单并发顺序执行 + 全部完成 ----------

describe("单并发顺序执行", () => {
  it("首个完成后才启动下一个；进度回调节流写库；完成行记总量", async () => {
    const db = makeDb();
    const { manager, dl } = makeManager(db, root);
    const { taskIds: ids } = await manager.enqueueDownload(
      hfArgs({
        files: [
          { file: SHARD1, size: 100 },
          { file: SHARD2, size: 50 },
        ],
      }),
    );

    expect(dl.calls).toHaveLength(1);
    // 进度写库（测试注入 intervalMs=0，全量写）
    dl.calls[0].progress({ downloaded: 40, total: 100, bytesPerSec: 1 });
    expect(taskRow(db, ids[0]).downloaded_bytes).toBe(40);

    dl.handles[0].resolveWith({ ok: true, bytes: 100, sha256Verified: "skipped", resumedFrom: 0 });
    await flush();

    expect(taskRow(db, ids[0])).toMatchObject({ status: "completed", downloaded_bytes: 100 });
    expect(dl.calls).toHaveLength(2);
    expect(taskRow(db, ids[1]).status).toBe("downloading");
    expect(dl.calls[1].req.targetPath).toBe(path.join(root, "main", SHARD2));

    dl.handles[1].resolveWith({ ok: true, bytes: 50, sha256Verified: "skipped", resumedFrom: 0 });
    await flush();

    expect(taskRow(db, ids[1])).toMatchObject({ status: "completed", downloaded_bytes: 50 });
    // 队列空：不再有新调用
    expect(dl.calls).toHaveLength(2);
    expect(manager.getQueueHead()).toBeNull();
  });

  it("进度写库节流：intervalMs 内多次回调只落一次", async () => {
    const db = makeDb();
    const { manager, dl } = makeManager(db, root, mockDownloader(), 60_000);
    const { taskIds: ids } = await manager.enqueueDownload(
      hfArgs({ files: [{ file: SHARD1, size: 100 }] }),
    );

    dl.calls[0].progress({ downloaded: 10, total: 100, bytesPerSec: 1 });
    dl.calls[0].progress({ downloaded: 80, total: 100, bytesPerSec: 1 });
    expect(taskRow(db, ids[0]).downloaded_bytes).toBe(10);
  });

  it("完成后把下载器实际算出的 sha256 写回任务行（设计 §1.3：URL 直链原先入队值为 NULL）", async () => {
    const db = makeDb();
    const { manager, dl } = makeManager(db, root);
    const { taskIds: ids } = await manager.enqueueDownload(
      hfArgs({
        source: "url",
        repo: undefined,
        url: "https://example.com/model.gguf",
        label: "example.com",
        files: [{ file: "model.gguf" }],
      }),
    );
    expect(taskRow(db, ids[0]).sha256).toBeNull(); // 入队时 URL 直链无期望值

    dl.handles[0].resolveWith({
      ok: true,
      bytes: 100,
      sha256: "b".repeat(64),
      sha256Verified: "skipped",
      resumedFrom: 0,
    });
    await flush();

    expect(taskRow(db, ids[0]).sha256).toBe("b".repeat(64));
  });

  it("下载器结果未带 sha256 时不覆盖既有值（兼容旧调用方不产出 actualSha 的场景）", async () => {
    const db = makeDb();
    const { manager, dl } = makeManager(db, root);
    const { taskIds: ids } = await manager.enqueueDownload(
      hfArgs({ files: [{ file: SHARD1, size: 100, sha256: "a".repeat(64) }] }),
    );

    dl.handles[0].resolveWith({ ok: true, bytes: 100, sha256Verified: "skipped", resumedFrom: 0 });
    await flush();

    expect(taskRow(db, ids[0]).sha256).toBe("a".repeat(64)); // 未被清空
  });
});

// ---------- 2b. 批次归档（按 batch_id 聚合，不再靠时间窗口凑批） ----------

describe("批次归档", () => {
  it("同一批的多个文件全部完成后归档为一条，total_bytes 是全部文件之和", async () => {
    const db = makeDb();
    const repoId = seedRepo(db);
    const { manager, dl } = makeManager(db, root);
    const { batchId } = await manager.enqueueDownload(
      hfArgs({
        repoId,
        targetDir: "hf/o/r",
        repo: "o/r",
        label: "o/r",
        files: [
          { file: "big.gguf", size: 2000 },
          { file: "mmproj.gguf", size: 1000 },
        ],
      }),
    );
    await runQueueToCompletion(manager, dl);

    const history = db
      .prepare("SELECT * FROM download_history WHERE batch_id = ?")
      .get(batchId) as HistoryRow;
    expect(history).toMatchObject({ repo_id: repoId, label: "o/r", status: "completed" });
    expect(history.total_bytes).toBe(3000);
    expect(JSON.parse(history.files)).toEqual([
      { file: "big.gguf", target_rel: "hf/o/r/big.gguf", bytes: 2000 },
      { file: "mmproj.gguf", target_rel: "hf/o/r/mmproj.gguf", bytes: 1000 },
    ]);

    const complete = events(db).filter((e) => e.kind === "download.complete");
    expect(complete).toHaveLength(1);
    expect(complete[0].message).toContain("o/r");
  });

  it("两个批次各自归档，互不吞并", async () => {
    const db = makeDb();
    const { manager, dl } = makeManager(db, root);
    const a = await manager.enqueueDownload(hfArgs({ files: [{ file: "a.gguf", size: 100 }] }));
    await runQueueToCompletion(manager, dl);
    const b = await manager.enqueueDownload(hfArgs({ files: [{ file: "b.gguf", size: 200 }] }));
    await runQueueToCompletion(manager, dl);

    const rows = historyRows(db);
    expect(rows.map((r) => r.batch_id)).toEqual([a.batchId, b.batchId]);
    expect(rows.map((r) => r.total_bytes)).toEqual([100, 200]);
  });

  it("批次内还有文件未完成时不归档", async () => {
    const db = makeDb();
    const { manager, dl } = makeManager(db, root);
    const { batchId } = await manager.enqueueDownload(
      hfArgs({
        files: [
          { file: "c.gguf", size: 100 },
          { file: "d.gguf", size: 100 },
        ],
      }),
    );
    // 只把第一个任务推到完成，第二个留在队列里
    await runOneTask(dl);

    const count = db
      .prepare("SELECT COUNT(*) AS c FROM download_history WHERE batch_id = ?")
      .get(batchId) as { c: number };
    expect(count.c).toBe(0);
  });

  it("批内有失败行时归档为 partial，只收完成的文件", async () => {
    const db = makeDb();
    const { manager, dl } = makeManager(db, root);
    const { batchId } = await manager.enqueueDownload(
      hfArgs({
        files: [
          { file: "e.gguf", size: 100 },
          { file: "f.gguf", size: 200 },
        ],
      }),
    );
    dl.handles[0].rejectWith(new Error("boom"));
    await flush();
    await runOneTask(dl);

    const history = db
      .prepare("SELECT * FROM download_history WHERE batch_id = ?")
      .get(batchId) as HistoryRow;
    expect(history).toMatchObject({ status: "partial", total_bytes: 200 });
    expect(JSON.parse(history.files)).toHaveLength(1);
  });

  it("批内取消一行、其余完成后仍归档为 partial（cancelled 不等于 completed）", async () => {
    const db = makeDb();
    const { manager, dl } = makeManager(db, root);
    const { taskIds: ids, batchId } = await manager.enqueueDownload(
      hfArgs({
        files: [
          { file: "p.gguf", size: 100 },
          { file: "q.gguf", size: 200 },
          { file: "r.gguf", size: 300 },
        ],
      }),
    );

    // 队列单并发，此时只有第一个任务已启动，第三个仍是 pending，可直接取消
    await manager.cancel(ids[2]);
    await runOneTask(dl); // 完成第一个，接棒第二个
    await runOneTask(dl); // 完成第二个，批次到达终态

    const history = db
      .prepare("SELECT * FROM download_history WHERE batch_id = ?")
      .get(batchId) as HistoryRow;
    expect(history).toMatchObject({ status: "partial", total_bytes: 300 });
    expect(JSON.parse(history.files)).toHaveLength(2);
    expect(taskRow(db, ids[2]).status).toBe("cancelled");
  });

  it("批内 1 行失败、其余完成后仍归档为 partial（确认原有 failed 场景不受新判定影响）", async () => {
    const db = makeDb();
    const { manager, dl } = makeManager(db, root);
    const { batchId } = await manager.enqueueDownload(
      hfArgs({
        files: [
          { file: "s.gguf", size: 100 },
          { file: "t.gguf", size: 200 },
          { file: "u.gguf", size: 300 },
        ],
      }),
    );

    await runOneTask(dl); // 完成第一个，接棒第二个
    dl.handles[dl.handles.length - 1].rejectWith(new Error("boom"));
    await flush(); // 第二个失败，未达阈值照常接棒第三个
    await runOneTask(dl); // 完成第三个，批次到达终态

    const history = db
      .prepare("SELECT * FROM download_history WHERE batch_id = ?")
      .get(batchId) as HistoryRow;
    expect(history).toMatchObject({ status: "partial", total_bytes: 400 });
    expect(JSON.parse(history.files)).toHaveLength(2);
  });

  it("失败行重试成功后覆盖原归档，不并排插第二条", async () => {
    const db = makeDb();
    const { manager, dl } = makeManager(db, root);
    const { taskIds: ids, batchId } = await manager.enqueueDownload(
      hfArgs({
        files: [
          { file: "g.gguf", size: 100 },
          { file: "h.gguf", size: 200 },
        ],
      }),
    );
    dl.handles[0].rejectWith(new Error("boom"));
    await flush();
    await runOneTask(dl);
    expect(historyRows(db)).toHaveLength(1);

    await manager.retry(ids[0]);
    await runOneTask(dl);

    const rows = historyRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ batch_id: batchId, status: "completed", total_bytes: 300 });
  });
});

// ---------- 3. 失败（连续失败未达阈值照常接棒，达阈值才停队；见 manager.ts kick 顶部注释） ----------

describe("失败", () => {
  it("单任务网络错误：行 failed 记原因，events 记 download.failed，未达阈值时接棒下一个", async () => {
    const db = makeDb();
    const { manager, dl } = makeManager(db, root);
    const { taskIds: ids } = await manager.enqueueDownload(
      hfArgs({
        files: [
          { file: SHARD1, size: 100 },
          { file: SHARD2, size: 100 },
        ],
      }),
    );

    dl.handles[0].rejectWith(new DownloadError("NETWORK_ERROR", "网络错误: boom"));
    await flush();

    expect(taskRow(db, ids[0])).toMatchObject({ status: "failed" });
    expect(taskRow(db, ids[0]).error).toContain("boom");
    // 未达连续失败阈值：照常接棒下一个 pending（单文件失败不该连坐整批）
    expect(dl.calls).toHaveLength(2);
    expect(taskRow(db, ids[1]).status).toBe("downloading");
    expect(manager.getQueueHead()).toBe(ids[1]);

    const failed = events(db).filter((e) => e.kind === "download.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].message).toContain(REPO);
    expect(failed[0].message).toContain(SHARD1);
  });

  it("连续失败达到阈值（3 次）后停队，第 4 个任务保持 pending，记 download.queue_stalled 事件", async () => {
    const db = makeDb();
    const { manager, dl } = makeManager(db, root);
    const { taskIds: ids } = await manager.enqueueDownload(
      hfArgs({
        files: [
          { file: SHARD1, size: 100 },
          { file: SHARD2, size: 100 },
          { file: MMPROJ, size: 10 },
          { file: "extra-1.gguf", size: 10 },
        ],
      }),
    );

    dl.handles[0].rejectWith(new DownloadError("NETWORK_ERROR", "网络错误: boom"));
    await flush();
    expect(taskRow(db, ids[1]).status).toBe("downloading"); // 第 1 次失败：接棒

    dl.handles[1].rejectWith(new DownloadError("NETWORK_ERROR", "网络错误: boom"));
    await flush();
    expect(taskRow(db, ids[2]).status).toBe("downloading"); // 第 2 次失败：接棒

    dl.handles[2].rejectWith(new DownloadError("NETWORK_ERROR", "网络错误: boom"));
    await flush();

    // 第 3 次失败达到阈值：停队，第 4 个保持 pending
    expect(dl.calls).toHaveLength(3);
    expect(taskRow(db, ids[3]).status).toBe("pending");
    expect(manager.getQueueHead()).toBeNull();

    const stalled = events(db).filter((e) => e.kind === "download.queue_stalled");
    expect(stalled).toHaveLength(1);
  });

  it("停队后新入队只排队不复活队列：待 resumeQueue 恢复且计数归零，之后连续失败 2 次不停队", async () => {
    const db = makeDb();
    const { manager, dl } = makeManager(db, root);
    const { taskIds: ids } = await manager.enqueueDownload(
      hfArgs({
        files: [
          { file: SHARD1, size: 100 },
          { file: SHARD2, size: 100 },
          { file: MMPROJ, size: 10 },
          { file: "extra-1.gguf", size: 10 },
          { file: "extra-2.gguf", size: 10 },
        ],
      }),
    );

    dl.handles[0].rejectWith(new DownloadError("NETWORK_ERROR", "网络错误: boom"));
    await flush();
    dl.handles[1].rejectWith(new DownloadError("NETWORK_ERROR", "网络错误: boom"));
    await flush();
    dl.handles[2].rejectWith(new DownloadError("NETWORK_ERROR", "网络错误: boom"));
    await flush();
    // 达阈值停队：extra-1 仍 pending
    expect(dl.calls).toHaveLength(3);
    expect(taskRow(db, ids[3]).status).toBe("pending");

    // 停队中新入队只排队不复活（M5 起恢复必须走显式 resumeQueue，避免停摆被无意解除）
    const { taskIds: extra3 } = await manager.enqueueDownload(
      hfArgs({ files: [{ file: "extra-3.gguf", size: 10 }] }),
    );
    expect(dl.calls).toHaveLength(3);
    expect(taskRow(db, ids[3]).status).toBe("pending");
    expect(taskRow(db, extra3[0]).status).toBe("pending");

    // resumeQueue 顶起被饿死的 extra-1（最早的 pending），且计数归零
    manager.resumeQueue();
    expect(dl.calls).toHaveLength(4);
    expect(taskRow(db, ids[3]).status).toBe("downloading");

    // 归零后再连续失败 2 次（extra-1、extra-2）：未达阈值，extra-3 接棒而非停队
    dl.handles[3].rejectWith(new DownloadError("NETWORK_ERROR", "网络错误: boom"));
    await flush();
    dl.handles[4].rejectWith(new DownloadError("NETWORK_ERROR", "网络错误: boom"));
    await flush();
    expect(dl.calls).toHaveLength(6);
    expect(taskRow(db, extra3[0]).status).toBe("downloading");
  });

  it("停队后 resume 暂停的任务也能重新开跑，且连续失败计数已归零", async () => {
    const db = makeDb();
    const { manager, dl } = makeManager(db, root);
    const { taskIds: ids } = await manager.enqueueDownload(
      hfArgs({
        files: [
          { file: SHARD1, size: 100 },
          { file: SHARD2, size: 100 },
          { file: MMPROJ, size: 10 },
          { file: "extra-1.gguf", size: 10 },
        ],
      }),
    );

    // 暂停排队中的 SHARD2：不参与后续失败链路，留作 resume 的靶子
    await manager.pause(ids[1]);
    expect(taskRow(db, ids[1]).status).toBe("paused");

    dl.handles[0].rejectWith(new DownloadError("NETWORK_ERROR", "网络错误: boom"));
    await flush();
    expect(taskRow(db, ids[2]).status).toBe("downloading"); // MMPROJ 接棒（SHARD2 已暂停跳过）

    dl.handles[1].rejectWith(new DownloadError("NETWORK_ERROR", "网络错误: boom"));
    await flush();
    expect(taskRow(db, ids[3]).status).toBe("downloading"); // extra-1 接棒

    dl.handles[2].rejectWith(new DownloadError("NETWORK_ERROR", "网络错误: boom"));
    await flush();
    // 第 3 次失败达到阈值：停队，队列空转（SHARD2 是 paused 不是 pending，无人可接）
    expect(dl.calls).toHaveLength(3);
    expect(manager.getQueueHead()).toBeNull();

    // resume 顶起 SHARD2，且计数归零
    await manager.resume(ids[1]);
    expect(dl.calls).toHaveLength(4);
    expect(taskRow(db, ids[1]).status).toBe("downloading");
  });

  it("resumeQueue 顶起停队后被饿死的 pending 任务并清零计数", async () => {
    const db = makeDb();
    const { manager, dl } = makeManager(db, root);
    // 三连失败触发停队
    for (let i = 0; i < 3; i++) {
      await manager.enqueueDownload(hfArgs({ files: [{ file: `f${i}.gguf` }], label: `m${i}` }));
      await flush();
      dl.handles[i].rejectWith(new Error("boom"));
      await flush();
    }
    // 第四个任务此刻被饿死：停队中新入队只排队不复活队列
    await manager.enqueueDownload(hfArgs({ files: [{ file: "f3.gguf" }], label: "m3" }));
    await flush();
    expect(manager.listTasks().find((t) => t.file === "f3.gguf")?.status).toBe("pending");

    manager.resumeQueue();
    await flush();
    expect(manager.listTasks().find((t) => t.file === "f3.gguf")?.status).toBe("downloading");
  });

  it("resumeQueue 在队列正常运行时是安全的 no-op（不双开任务）", async () => {
    const db = makeDb();
    const { manager, dl } = makeManager(db, root);
    await manager.enqueueDownload(
      hfArgs({ files: [{ file: "a.gguf" }, { file: "b.gguf" }], label: "a" }),
    );
    await flush();
    const before = dl.handles.length;
    manager.resumeQueue();
    await flush();
    expect(dl.handles.length).toBe(before); // active 非空，kick 直接返回
  });

  it("中途成功归零连续失败计数：之后再连续失败 2 次不停队", async () => {
    const db = makeDb();
    const { manager, dl } = makeManager(db, root);
    const { taskIds: ids } = await manager.enqueueDownload(
      hfArgs({
        files: [
          { file: SHARD1, size: 100 },
          { file: SHARD2, size: 100 },
          { file: MMPROJ, size: 10 },
          { file: "extra-1.gguf", size: 10 },
          { file: "extra-2.gguf", size: 10 },
          { file: "extra-3.gguf", size: 10 },
        ],
      }),
    );

    dl.handles[0].rejectWith(new DownloadError("NETWORK_ERROR", "网络错误: boom")); // 第 1 次失败
    await flush();
    dl.handles[1].rejectWith(new DownloadError("NETWORK_ERROR", "网络错误: boom")); // 第 2 次失败
    await flush();
    dl.handles[2].resolveWith({ ok: true, bytes: 10, sha256Verified: "skipped", resumedFrom: 0 }); // 成功归零
    await flush();
    expect(taskRow(db, ids[3]).status).toBe("downloading");

    dl.handles[3].rejectWith(new DownloadError("NETWORK_ERROR", "网络错误: boom")); // 归零后第 1 次失败
    await flush();
    dl.handles[4].rejectWith(new DownloadError("NETWORK_ERROR", "网络错误: boom")); // 归零后第 2 次失败
    await flush();

    // 仅 2 次连续失败，未达阈值：extra-3 接棒而非停队
    expect(dl.calls).toHaveLength(6);
    expect(taskRow(db, ids[5]).status).toBe("downloading");
    expect(events(db).filter((e) => e.kind === "download.queue_stalled")).toHaveLength(0);
  });
});

// ---------- 3b. 同步启动失败（buildRequest / downloader 同步抛错，与运行期失败同语义） ----------

describe("同步启动失败", () => {
  it("downloader 同步抛错：行 failed 记原因，未达阈值时接棒下一个 pending", async () => {
    const db = makeDb();
    const dl = mockDownloader({ throwSyncFor: (req) => req.targetPath.includes(SHARD1) });
    const { manager } = makeManager(db, root, dl);
    const { taskIds: ids } = await manager.enqueueDownload(
      hfArgs({
        files: [
          { file: SHARD1, size: 100 },
          { file: SHARD2, size: 100 },
        ],
      }),
    );

    expect(taskRow(db, ids[0])).toMatchObject({ status: "failed" });
    expect(taskRow(db, ids[0]).error).toContain("boom");
    // 未达连续失败阈值：照常接棒下一个 pending（不能卡在"connect 都没建过"的状态）
    expect(taskRow(db, ids[1]).status).toBe("downloading");
    expect(manager.getQueueHead()).toBe(ids[1]);
    expect(dl.calls).toHaveLength(1); // 只有 SHARD2 真正建了句柄

    const failed = events(db).filter((e) => e.kind === "download.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].message).toContain(SHARD1);
  });

  it("同步失败与异步失败混合计入同一条连续失败计数：凑满 3 次即停队", async () => {
    const db = makeDb();
    // SHARD1、MMPROJ 同步抛错；SHARD2 走正常句柄由测试手动 reject（异步失败）
    const dl = mockDownloader({
      throwSyncFor: (req) => req.targetPath.includes(SHARD1) || req.targetPath.includes(MMPROJ),
    });
    const { manager } = makeManager(db, root, dl);
    const { taskIds: ids } = await manager.enqueueDownload(
      hfArgs({
        files: [
          { file: SHARD1, size: 100 }, // 同步失败（第 1 次）
          { file: SHARD2, size: 100 }, // 异步失败（第 2 次）
          { file: MMPROJ, size: 10 }, // 同步失败（第 3 次，达阈值）
          { file: "extra-1.gguf", size: 10 },
        ],
      }),
    );

    // enqueue 内 kick() 同步链：SHARD1 同步失败 → 接棒 SHARD2，建了句柄，等待外部 reject
    expect(taskRow(db, ids[0]).status).toBe("failed");
    expect(taskRow(db, ids[1]).status).toBe("downloading");
    expect(dl.handles).toHaveLength(1);

    dl.handles[0].rejectWith(new DownloadError("NETWORK_ERROR", "网络错误: boom"));
    await flush();

    // SHARD2 异步失败（第 2 次）→ 接棒 MMPROJ，同步失败（第 3 次，达阈值）→ 停队
    expect(taskRow(db, ids[1]).status).toBe("failed");
    expect(taskRow(db, ids[2]).status).toBe("failed");
    expect(taskRow(db, ids[3]).status).toBe("pending");
    expect(manager.getQueueHead()).toBeNull();
    expect(dl.handles).toHaveLength(1); // MMPROJ 从未建成句柄

    const stalled = events(db).filter((e) => e.kind === "download.queue_stalled");
    expect(stalled).toHaveLength(1);
  });

  it("连续同步失败达到阈值即停止递归：不会栈溢出，也不会把所有 pending 都刷成 failed", async () => {
    const db = makeDb();
    const dl = mockDownloader({ throwSyncFor: () => true });
    const { manager } = makeManager(db, root, dl);
    const { taskIds: ids } = await manager.enqueueDownload(
      hfArgs({
        files: [
          { file: SHARD1, size: 100 },
          { file: SHARD2, size: 100 },
          { file: MMPROJ, size: 10 },
          { file: "extra-1.gguf", size: 10 },
          { file: "extra-2.gguf", size: 10 },
        ],
      }),
    );

    // 前 3 个连续同步失败达到阈值后停队递归；第 4/5 个不会被继续刷成 failed
    expect(taskRow(db, ids[0]).status).toBe("failed");
    expect(taskRow(db, ids[1]).status).toBe("failed");
    expect(taskRow(db, ids[2]).status).toBe("failed");
    expect(taskRow(db, ids[3]).status).toBe("pending");
    expect(taskRow(db, ids[4]).status).toBe("pending");
    expect(manager.getQueueHead()).toBeNull();
    expect(dl.calls).toHaveLength(0); // 全部同步抛错：从未成功建过 handle
    expect(dl.fn).toHaveBeenCalledTimes(3); // 递归深度被阈值卡死，恰好尝试 3 次
    expect(events(db).filter((e) => e.kind === "download.queue_stalled")).toHaveLength(1);
  });
});

// ---------- 5. pause / resume / cancel ----------

describe("pause/resume", () => {
  it("暂停活动任务：行 paused、释放并发位（新任务可跑）；resume 回 pending 且按 id 序保留队列位", async () => {
    const db = makeDb();
    const { manager, dl } = makeManager(db, root);
    const { taskIds: ids } = await manager.enqueueDownload(
      hfArgs({ files: [{ file: SHARD1, size: 100 }] }),
    );

    await manager.pause(ids[0]);
    expect(dl.handles[0].pause).toHaveBeenCalled();
    expect(taskRow(db, ids[0]).status).toBe("paused");
    expect(manager.getQueueHead()).toBeNull();

    // 暂停释放并发位：入队新任务立即开跑（与重启恢复"pending 继续跑、paused 等用户"同语义）
    const { taskIds: ids2 } = await manager.enqueueDownload(
      hfArgs({ files: [{ file: MMPROJ, size: 10 }] }),
    );
    expect(dl.calls).toHaveLength(2);

    // resume 把行回 pending：不打断活动任务，但排在所有更大 id 的 pending 之前
    await manager.resume(ids[0]);
    expect(taskRow(db, ids[0]).status).toBe("pending");
    expect(dl.calls).toHaveLength(2); // 不新增调用：mmproj 仍在跑

    dl.handles[1].resolveWith({ ok: true, bytes: 10, sha256Verified: "skipped", resumedFrom: 0 });
    await flush();
    // mmproj 完成后 resumed 的 SHARD1（id 更小）接棒，保留队列位
    expect(dl.calls).toHaveLength(3);
    expect(dl.calls[2].req.targetPath).toBe(path.join(root, "main", SHARD1));
    expect(taskRow(db, ids[0]).status).toBe("downloading");
    expect(taskRow(db, ids2[0]).status).toBe("completed");
  });

  it("暂停未开始的任务直接置 paused（无句柄）；resume 后 kick", async () => {
    const db = makeDb();
    const { manager, dl } = makeManager(db, root);
    const { taskIds: ids } = await manager.enqueueDownload(
      hfArgs({
        files: [
          { file: SHARD1, size: 100 },
          { file: SHARD2, size: 100 },
        ],
      }),
    );
    await manager.pause(ids[1]);
    expect(taskRow(db, ids[1]).status).toBe("paused");

    dl.handles[0].resolveWith({ ok: true, bytes: 100, sha256Verified: "skipped", resumedFrom: 0 });
    await flush();
    // SHARD2 paused 不接棒，队列空转
    expect(dl.calls).toHaveLength(1);
    expect(manager.getQueueHead()).toBeNull();

    await manager.resume(ids[1]);
    expect(dl.calls).toHaveLength(2);
    expect(taskRow(db, ids[1]).status).toBe("downloading");
  });

  it("任务不存在时 pause/resume/cancel 抛错（404 语义）", async () => {
    const db = makeDb();
    const { manager } = makeManager(db, root);
    await expect(manager.pause(999)).rejects.toThrow(/任务不存在/);
    await expect(manager.resume(999)).rejects.toThrow(/任务不存在/);
    await expect(manager.cancel(999)).rejects.toThrow(/任务不存在/);
  });
});

describe("cancel", () => {
  it("取消活动任务：透传句柄 cancel、行 cancelled、队列继续下一个", async () => {
    const db = makeDb();
    const { manager, dl } = makeManager(db, root);
    const { taskIds: ids } = await manager.enqueueDownload(
      hfArgs({
        files: [
          { file: SHARD1, size: 100 },
          { file: SHARD2, size: 100 },
        ],
      }),
    );

    await manager.cancel(ids[0]);
    expect(dl.handles[0].cancel).toHaveBeenCalled();
    expect(taskRow(db, ids[0]).status).toBe("cancelled");
    // 队列继续
    expect(dl.calls).toHaveLength(2);
    expect(taskRow(db, ids[1]).status).toBe("downloading");
  });

  it("取消排队中任务：行 cancelled 且本地 .part/.part.meta.json 被删除，活动任务不受影响", async () => {
    const db = makeDb();
    const { manager, dl } = makeManager(db, root);
    const { taskIds: ids } = await manager.enqueueDownload(
      hfArgs({
        files: [
          { file: SHARD1, size: 100 },
          { file: SHARD2, size: 100 },
        ],
      }),
    );

    // 给排队中的任务伪造 .part（模拟面板重启恢复的残留）
    mkdirSync(path.join(root, "main"), { recursive: true });
    const part = path.join(root, "main", `${SHARD2}.part`);
    const meta = `${part}.meta.json`;
    writeFileSync(part, "partial");
    writeFileSync(meta, "{}");

    await manager.cancel(ids[1]);
    expect(taskRow(db, ids[1]).status).toBe("cancelled");
    expect(existsSync(part)).toBe(false);
    expect(existsSync(meta)).toBe(false);
    expect(taskRow(db, ids[0]).status).toBe("downloading");
    expect(dl.calls).toHaveLength(1);
  });
});

// ---------- 6. 重启恢复 ----------

describe("recoverOnBoot", () => {
  function seedTask(db: Database.Database, status: string, file: string): number {
    const now = Date.now();
    const info = db
      .prepare(
        `INSERT INTO download_tasks(batch_id, label, kind, source, repo, file, target_rel, status, created_at, updated_at)
         VALUES ('batch-boot', ?, 'gguf', 'hf', ?, ?, ?, ?, ?, ?)`,
      )
      .run(REPO, REPO, file, `main/${file}`, status, now, now);
    return Number(info.lastInsertRowid);
  }

  it(".part 存在 → paused（可续传）；不存在 → pending；恢复后自动 kick 一次跑 pending", async () => {
    const db = makeDb();
    const dl = mockDownloader();
    const manager = createDownloadManager(db, { downloader: dl.fn, modelsRoot: root });

    mkdirSync(path.join(root, "main"), { recursive: true });
    const withPart1 = seedTask(db, "downloading", SHARD1);
    const withPart2 = seedTask(db, "pending", MMPROJ);
    const withoutPart = seedTask(db, "downloading", SHARD2);
    writeFileSync(path.join(root, "main", `${SHARD1}.part`), "partial");
    writeFileSync(path.join(root, "main", `${MMPROJ}.part`), "partial");

    await manager.recoverOnBoot();

    expect(taskRow(db, withPart1).status).toBe("paused");
    expect(taskRow(db, withPart2).status).toBe("paused");
    expect(taskRow(db, withoutPart).status).toBe("downloading"); // 自动 kick 接跑
    expect(dl.calls).toHaveLength(1);
    expect(dl.calls[0].req.targetPath).toBe(path.join(root, "main", SHARD2));
    // .part 保留（可续传语义，删除只发生在 cancel）
    expect(existsSync(path.join(root, "main", `${SHARD1}.part`))).toBe(true);
  });
});

// ---------- 7. listTasks / getQueueHead ----------

describe("listTasks / getQueueHead", () => {
  it("返回任务视图：批次/档案/标签、进度、队列位置（pending 按 id 序 0 基）；head 指向活动任务", async () => {
    const db = makeDb();
    const repoId = seedRepo(db);
    const { manager, dl } = makeManager(db, root);
    const { taskIds: ids, batchId } = await manager.enqueueDownload(
      hfArgs({
        repoId,
        files: [
          { file: SHARD1, size: 100 },
          { file: SHARD2, size: 100 },
          { file: MMPROJ, size: 10 },
        ],
      }),
    );
    dl.calls[0].progress({ downloaded: 55, total: 100, bytesPerSec: 1 });

    const tasks = manager.listTasks();
    expect(tasks).toHaveLength(3);
    expect(tasks.every((t) => t.batchId === batchId && t.repoId === repoId && t.label === REPO)).toBe(
      true,
    );
    const byId = new Map(tasks.map((t) => [t.id, t]));
    expect(byId.get(ids[0])).toMatchObject({
      status: "downloading",
      downloadedBytes: 55,
      queuePosition: null,
    });
    expect(byId.get(ids[1])).toMatchObject({ status: "pending", queuePosition: 0 });
    expect(byId.get(ids[2])).toMatchObject({ status: "pending", queuePosition: 1 });
    expect(manager.getQueueHead()).toBe(ids[0]);
  });
});

// ---------- 8. 并发安全 / 重复入队 ----------

describe("重复入队与追加", () => {
  it("同一 target_rel 已有未完成任务时拒绝重复入队（409 语义）", async () => {
    const db = makeDb();
    const { manager, dl } = makeManager(db, root);
    await manager.enqueueDownload(hfArgs({ files: [{ file: SHARD1, size: 100 }] }));

    await expect(manager.enqueueDownload(hfArgs({ files: [{ file: SHARD1 }] }))).rejects.toThrow(
      /已有未完成的下载任务/,
    );
    expect(taskRows(db)).toHaveLength(1);
    expect(dl.calls).toHaveLength(1);
  });

  it("已完成的 target_rel 可重新入队（补下载/重试）", async () => {
    const db = makeDb();
    const { manager, dl } = makeManager(db, root);
    const first = await manager.enqueueDownload(hfArgs({ files: [{ file: SHARD1, size: 100 }] }));
    dl.handles[0].resolveWith({ ok: true, bytes: 100, sha256Verified: "skipped", resumedFrom: 0 });
    await flush();
    expect(taskRow(db, first.taskIds[0]).status).toBe("completed");

    const second = await manager.enqueueDownload(hfArgs({ files: [{ file: SHARD1, size: 100 }] }));
    expect(second.taskIds[0]).not.toBe(first.taskIds[0]);
    expect(second.batchId).not.toBe(first.batchId);
    expect(taskRows(db)).toHaveLength(2);
    expect(dl.calls).toHaveLength(2); // 新任务自动 kick
  });

  it("运行中追加新批次：追加进队列，当前任务完成后按 id 顺序执行", async () => {
    const db = makeDb();
    const { manager, dl } = makeManager(db, root);
    await manager.enqueueDownload(hfArgs({ files: [{ file: SHARD1, size: 100 }] }));
    expect(dl.calls).toHaveLength(1);

    await manager.enqueueDownload(hfArgs({ files: [{ file: MMPROJ, size: 10 }] }));
    // 追加不打断当前
    expect(dl.calls).toHaveLength(1);

    dl.handles[0].resolveWith({ ok: true, bytes: 100, sha256Verified: "skipped", resumedFrom: 0 });
    await flush();
    expect(dl.calls).toHaveLength(2);
    expect(dl.calls[1].req.targetPath).toBe(path.join(root, "main", MMPROJ));
  });
});

// ---------- U25：失败/取消任务原地重试 + 清除已结束记录 ----------

describe("retry（U25 分片单独重试）", () => {
  it("failed 行回 pending 并接棒重下（下载器重新收到该文件），error 清空", async () => {
    const db = makeDb();
    const { manager, dl } = makeManager(db, root);
    const { taskIds: ids } = await manager.enqueueDownload(
      hfArgs({
        files: [
          { file: SHARD1, size: 100 },
          { file: SHARD2, size: 100 },
        ],
      }),
    );
    // 第一片失败 → 接棒第二片
    dl.handles[0].rejectWith(new Error("boom"));
    await flush();
    expect(taskRow(db, ids[0]).status).toBe("failed");
    expect(taskRow(db, ids[0]).error).toBe("boom");

    await manager.retry(ids[0]);
    // 第二片仍在跑（单并发），第一片在排队
    expect(taskRow(db, ids[0])).toMatchObject({ status: "pending", error: null });

    dl.handles[1].resolveWith({ ok: true, bytes: 100, sha256Verified: "skipped", resumedFrom: 0 });
    await flush();
    // 排队的重试任务接棒：下载器第二次收到 SHARD1
    const urls = dl.calls.map((c) => c.req.url);
    expect(urls.filter((u) => u.endsWith(SHARD1))).toHaveLength(2);
    expect(taskRow(db, ids[0]).status).toBe("downloading");
  });

  it("cancelled 行可重试；completed 与 paused 行拒绝（409 语义）；不存在抛错（404 语义）", async () => {
    const db = makeDb();
    const { manager, dl } = makeManager(db, root);
    const { taskIds: ids } = await manager.enqueueDownload(
      hfArgs({ files: [{ file: SHARD1, size: 100 }] }),
    );
    dl.handles[0].resolveWith({ ok: true, bytes: 100, sha256Verified: "skipped", resumedFrom: 0 });
    await flush();
    await expect(manager.retry(ids[0])).rejects.toThrow("仅失败或已取消的任务可重试");

    const paused = await manager.enqueueDownload(hfArgs({ files: [{ file: SHARD2, size: 100 }] }));
    await manager.pause(paused.taskIds[0]);
    await expect(manager.retry(paused.taskIds[0])).rejects.toThrow("仅失败或已取消的任务可重试");

    await expect(manager.retry(9999)).rejects.toThrow("任务不存在");

    // cancelled：本地取消排队任务后可原地重试（此时队列空闲，retry 立即接棒开跑）
    const cancelled = await manager.enqueueDownload(hfArgs({ files: [{ file: MMPROJ, size: 10 }] }));
    await manager.cancel(cancelled.taskIds[0]);
    expect(taskRow(db, cancelled.taskIds[0]).status).toBe("cancelled");
    await manager.retry(cancelled.taskIds[0]);
    expect(taskRow(db, cancelled.taskIds[0])).toMatchObject({
      status: "downloading",
      error: null,
    });
    expect(dl.calls.at(-1)?.req.targetPath).toBe(path.join(root, "main", MMPROJ));
  });
});

describe("clearFinished（U25 清除历史）", () => {
  it("删除 completed/failed/cancelled 行与全部历史归档，未完成行保留，记 download.clear 事件", async () => {
    const db = makeDb();
    const { manager, dl } = makeManager(db, root);
    // 批次 A：完成（会归档一条历史）
    await manager.enqueueDownload(hfArgs({ files: [{ file: SHARD1, size: 100 }] }));
    dl.handles[0].resolveWith({ ok: true, bytes: 100, sha256Verified: "skipped", resumedFrom: 0 });
    await flush();
    // 批次 B：一片失败
    await manager.enqueueDownload(hfArgs({ files: [{ file: SHARD2, size: 100 }], label: "other" }));
    dl.handles[1].rejectWith(new Error("boom"));
    await flush();
    // 批次 C：排队中
    await manager.enqueueDownload(hfArgs({ files: [{ file: MMPROJ, size: 10 }], label: "third" }));
    expect(historyRows(db)).toHaveLength(1);

    const cleared = manager.clearFinished();
    expect(cleared).toEqual({ tasks: 2, history: 1 }); // completed SHARD1 + failed SHARD2
    const remain = taskRows(db);
    expect(remain.map((r) => r.status)).toEqual(["downloading"]); // 批次 C 的 MMPROJ 不受影响
    expect(historyRows(db)).toHaveLength(0);
    expect(events(db).some((e) => e.kind === "download.clear")).toBe(true);

    // 再清一次：只剩未完成行 → 计数为 0，不再记事件
    const again = manager.clearFinished();
    expect(again).toEqual({ tasks: 0, history: 0 });
    expect(events(db).filter((e) => e.kind === "download.clear")).toHaveLength(1);
  });
});

// ---------- 9. enqueueLocal：队列接入 local 源（本地权重迁移） ----------

describe("enqueueLocal", () => {
  it("local 任务走本地执行器，完成后落库 completed 并写回 sha256", async () => {
    const db = makeDb();
    const { manager } = makeManager(db, root);
    const src = path.join(root, "loose/a.gguf");
    mkdirSync(path.dirname(src), { recursive: true });
    writeFileSync(src, "payload");
    const sha = createHash("sha256").update("payload").digest("hex");

    const { taskIds, batchId } = await manager.enqueueLocal({
      items: [{ file: "a.gguf", sourcePath: src, action: "move", sameFs: true, size: 7, sha256: sha }],
      targetDir: "hf/o/R",
      label: "o/R",
    });
    await waitQueueIdle(manager);

    const row = taskRow(db, taskIds[0]);
    expect(row.status).toBe("completed");
    expect(row.source).toBe("local");
    expect(row.local_action).toBe("move");
    expect(row.sha256).toBe(sha);
    expect(row.batch_id).toBe(batchId);
    expect(existsSync(path.join(root, "hf/o/R/a.gguf"))).toBe(true);
    expect(existsSync(src)).toBe(false); // move：源文件被挪走
  });

  it("local 任务校验失败时标 failed 且 error 含原因，源文件原封不动", async () => {
    const db = makeDb();
    const { manager } = makeManager(db, root);
    const src = path.join(root, "loose/b.gguf");
    mkdirSync(path.dirname(src), { recursive: true });
    writeFileSync(src, "payload");

    const { taskIds } = await manager.enqueueLocal({
      items: [
        { file: "b.gguf", sourcePath: src, action: "move", sameFs: true, size: 7, sha256: "c".repeat(64) },
      ],
      targetDir: "hf/o/R",
      label: "o/R",
    });
    await waitQueueIdle(manager);

    const row = taskRow(db, taskIds[0]);
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/内容不符/);
    expect(existsSync(src)).toBe(true); // 校验没过，源文件必须原封不动
    expect(existsSync(path.join(root, "hf/o/R/b.gguf"))).toBe(false);
  });

  it("目标已存在且大小匹配时跳过：不入队、源文件不动、文件名回传 skipped（与 enqueueDownload 同一套判定）", async () => {
    const db = makeDb();
    const { manager } = makeManager(db, root);
    const src = path.join(root, "loose/c.gguf");
    mkdirSync(path.dirname(src), { recursive: true });
    writeFileSync(src, "payload");
    writeTargetFile("hf/o/R/c.gguf", 7);

    const { taskIds, skipped } = await manager.enqueueLocal({
      items: [
        { file: "c.gguf", sourcePath: src, action: "move", sameFs: true, size: 7, sha256: "d".repeat(64) },
      ],
      targetDir: "hf/o/R",
      label: "o/R",
    });

    expect(taskIds).toHaveLength(0);
    expect(taskRows(db)).toHaveLength(0);
    expect(existsSync(src)).toBe(true); // 没被当成任务处理，源文件原地不动
    // C1：调用方（acquire 路由 → 确认弹层）必须拿得到这份名单，否则弹层等不到
    // 这些文件的任务推送，整组永远判不出「已完成」
    expect(skipped).toEqual(["c.gguf"]);
  });

  it("分片组只跳过已存在的那片，其余照常入队，skipped 只列被跳过的那片", async () => {
    const db = makeDb();
    const { manager } = makeManager(db, root);
    const mkSrc = (name: string): string => {
      const p = path.join(root, "loose", name);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, "payload");
      return p;
    };
    const src1 = mkSrc(SHARD1);
    const src2 = mkSrc(SHARD2);
    writeTargetFile(`hf/o/R/${SHARD1}`, 7); // 第一片已经在目标位置

    const { taskIds, skipped } = await manager.enqueueLocal({
      items: [
        { file: SHARD1, sourcePath: src1, action: "move", sameFs: true, size: 7, sha256: "a".repeat(64) },
        { file: SHARD2, sourcePath: src2, action: "move", sameFs: true, size: 7, sha256: "b".repeat(64) },
      ],
      targetDir: "hf/o/R",
      label: "o/R",
    });

    expect(skipped).toEqual([SHARD1]);
    expect(taskIds).toHaveLength(1);
    expect(taskRows(db).map((r) => r.file)).toEqual([SHARD2]);
  });

  it("没有任何跳过时 skipped 是空数组（不是 undefined）", async () => {
    const db = makeDb();
    const { manager } = makeManager(db, root);
    const src = path.join(root, "loose/n.gguf");
    mkdirSync(path.dirname(src), { recursive: true });
    writeFileSync(src, "payload");
    const sha = createHash("sha256").update("payload").digest("hex");

    const { skipped } = await manager.enqueueLocal({
      items: [{ file: "n.gguf", sourcePath: src, action: "move", sameFs: true, size: 7, sha256: sha }],
      targetDir: "hf/o/R",
      label: "o/R",
    });
    await waitQueueIdle(manager);
    expect(skipped).toEqual([]);
  });

  it("copy 超过剩余磁盘空间时预检拒绝，不入队", async () => {
    const db = makeDb();
    const { manager } = makeManager(db, root);
    const src = path.join(root, "loose/e.gguf");
    mkdirSync(path.dirname(src), { recursive: true });
    writeFileSync(src, "payload");

    await expect(
      manager.enqueueLocal({
        items: [
          {
            file: "e.gguf",
            sourcePath: src,
            action: "copy",
            sameFs: false,
            size: Number.MAX_SAFE_INTEGER,
            sha256: "f".repeat(64),
          },
        ],
        targetDir: "hf/o/R",
        label: "o/R",
      }),
    ).rejects.toThrow(/磁盘空间不足/);
    expect(taskRows(db)).toHaveLength(0);
  });

  it("link / 同盘 move 不占盘：磁盘预检不拦，即便声明的 size 远超剩余空间", async () => {
    const db = makeDb();
    const { manager } = makeManager(db, root);
    const src = path.join(root, "loose/f.gguf");
    mkdirSync(path.dirname(src), { recursive: true });
    writeFileSync(src, "payload");

    const { taskIds } = await manager.enqueueLocal({
      items: [
        {
          file: "f.gguf",
          sourcePath: src,
          action: "link",
          sameFs: true,
          size: Number.MAX_SAFE_INTEGER,
          sha256: "g".repeat(64),
        },
      ],
      targetDir: "hf/o/R",
      label: "o/R",
    });
    expect(taskIds).toHaveLength(1); // 没被磁盘预检拦下，正常入队
    await waitQueueIdle(manager);

    // 真实失败原因是声明的 size 与源文件实际大小不符，不是「磁盘空间不足」——
    // 证明 link 这条路径确实没走磁盘预检
    const row = taskRow(db, taskIds[0]);
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/大小不符/);
    expect(row.error).not.toMatch(/磁盘空间不足/);
  });

  it("排队中（尚未开跑）的 local 任务可被暂停/恢复，恢复后仍按原队列位置等待、轮到后正常执行", async () => {
    const db = makeDb();
    const { manager, dl } = makeManager(db, root);
    const src = path.join(root, "loose/i.gguf");
    mkdirSync(path.dirname(src), { recursive: true });
    writeFileSync(src, "payload");
    const sha = createHash("sha256").update("payload").digest("hex");

    // 先占住唯一并发槽位的是一个可控 mock 下载任务，local 任务因此停在 pending，
    // 不会真的开始执行——暂停/恢复的断言才能是确定性的，不必赌真实 I/O 的时序
    await manager.enqueueDownload(hfArgs({ files: [{ file: "block1.gguf", size: 10 }] }));
    const { taskIds } = await manager.enqueueLocal({
      items: [{ file: "i.gguf", sourcePath: src, action: "move", sameFs: true, size: 7, sha256: sha }],
      targetDir: "hf/o/R",
      label: "o/R",
    });
    const localId = taskIds[0];
    expect(taskRow(db, localId).status).toBe("pending");

    await manager.pause(localId);
    expect(taskRow(db, localId).status).toBe("paused");

    await manager.resume(localId);
    expect(taskRow(db, localId).status).toBe("pending"); // 队列仍被前面的下载任务占着

    await runOneTask(dl); // 放行下载任务，队列接棒 local 任务（真实执行）
    await waitQueueIdle(manager);

    const row = taskRow(db, localId);
    expect(row.status).toBe("completed");
    expect(existsSync(path.join(root, "hf/o/R/i.gguf"))).toBe(true);
  });

  it("正在执行中的 local 任务被暂停：读写真正中断而非跑完才停，.part 半成品被清理；恢复后从头重跑并成功", async () => {
    const db = makeDb();
    const { manager } = makeManager(db, root);
    // 8MB 源 + setTimeout(5) 定时触发：与 localAcquire.test.ts「复制过程中取消」
    // 用的是同一套手法（该用例已在既有 2570 条基线里稳定通过），确保 pause() 落在
    // 真正的执行窗口内，而不是任务早已跑完才追上去调用
    const content = "y".repeat(8_000_000);
    const src = path.join(root, "loose/big.gguf");
    mkdirSync(path.dirname(src), { recursive: true });
    writeFileSync(src, content);
    const sha = createHash("sha256").update(content).digest("hex");
    const size = Buffer.byteLength(content);

    const { taskIds } = await manager.enqueueLocal({
      items: [{ file: "big.gguf", sourcePath: src, action: "copy", sameFs: false, size, sha256: sha }],
      targetDir: "hf/o/R",
      label: "o/R",
    });
    const taskId = taskIds[0];

    await new Promise((r) => setTimeout(r, 5)); // 让校验/复制先真跑起来，制造「执行中」的时机
    await manager.pause(taskId);

    const row = taskRow(db, taskId);
    expect(row.status).toBe("paused");
    // 真正被中断，不是读完才停：copy 的总工作量是 size*2（校验读一遍 + 复制写一遍），
    // 进度必须严格停在这之前——若已经跑到头，行会是 completed 而不是 paused，
    // 但这里额外钉住进度值，防止「凑巧在两阶段之间的整数边界被判定为完成」之类的巧合
    expect(row.downloaded_bytes).toBeGreaterThan(0);
    expect(row.downloaded_bytes).toBeLessThan(size * 2);

    const targetPath = path.join(root, "hf/o/R/big.gguf");
    expect(existsSync(targetPath)).toBe(false); // 没跑完，目标文件不该出现
    expect(existsSync(targetPath + ".part")).toBe(false); // 半成品被清理，不留残留
    expect(existsSync(src)).toBe(true); // 源文件还在（copy 本就不删源，暂停更不该删）

    await manager.resume(taskId);
    await waitQueueIdle(manager);

    // 本地获取不支持续传（localAcquire.ts 头部注释）：恢复后从头重跑，而不是接着断点续
    const finalRow = taskRow(db, taskId);
    expect(finalRow.status).toBe("completed");
    expect(existsSync(targetPath)).toBe(true);
    expect(statSync(targetPath).size).toBe(size);
  });

  it("排队中的 local 任务可被取消，队列不受影响照常放行后续任务", async () => {
    const db = makeDb();
    const { manager, dl } = makeManager(db, root);
    const src = path.join(root, "loose/j.gguf");
    mkdirSync(path.dirname(src), { recursive: true });
    writeFileSync(src, "payload");
    const sha = createHash("sha256").update("payload").digest("hex");

    await manager.enqueueDownload(hfArgs({ files: [{ file: "block2.gguf", size: 10 }] }));
    const { taskIds } = await manager.enqueueLocal({
      items: [{ file: "j.gguf", sourcePath: src, action: "move", sameFs: true, size: 7, sha256: sha }],
      targetDir: "hf/o/R",
      label: "o/R",
    });
    const localId = taskIds[0];

    await manager.cancel(localId);
    expect(taskRow(db, localId).status).toBe("cancelled");
    expect(existsSync(src)).toBe(true); // 任务还没跑就被取消，源文件不受影响

    await runOneTask(dl); // 下载任务收尾，cancelled 是终态不会被重新捡起
    expect(manager.getQueueHead()).toBeNull();
  });

  it("失败的 local 任务可重试，重新真实跑一遍执行器", async () => {
    const db = makeDb();
    const { manager } = makeManager(db, root);
    const src = path.join(root, "loose/k.gguf");
    mkdirSync(path.dirname(src), { recursive: true });
    writeFileSync(src, "payload");

    const { taskIds } = await manager.enqueueLocal({
      items: [
        { file: "k.gguf", sourcePath: src, action: "move", sameFs: true, size: 7, sha256: "c".repeat(64) },
      ],
      targetDir: "hf/o/R",
      label: "o/R",
    });
    await waitQueueIdle(manager);
    expect(taskRow(db, taskIds[0]).status).toBe("failed");

    await manager.retry(taskIds[0]);
    await waitQueueIdle(manager);

    // sha256 仍是错的，重试照样失败——这里验证的是「重试真的重新跑了执行器」而非结果本身
    const row = taskRow(db, taskIds[0]);
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/内容不符/);
    expect(existsSync(src)).toBe(true);
  });

  // I3：一次确认分两次入队，local 那半抛错（磁盘预检 507 / 并发占用 409）时
  // download 那半已经真实入队。不撤回的话用户重新提交必然撞上自己刚入队的那批
  // （同一落点已有未完成任务 → 409），除非去下载页手动取消，否则这个档案再也
  // 提交不了——这是一条无法在面板内自愈的路径
  it("cancelBatch：local 那半抛错后撤回同批已入队的 download 任务，同一批可以重新提交", async () => {
    const db = makeDb();
    const { manager } = makeManager(db, root);
    const batchId = "mixed-rollback";
    const src = path.join(root, "loose/rb.gguf");
    mkdirSync(path.dirname(src), { recursive: true });
    writeFileSync(src, "payload");

    await manager.enqueueDownload({
      files: [{ file: "rb-remote.gguf", size: 10 }],
      targetDir: "hf/o/R",
      source: "hf",
      repo: "o/R",
      label: "o/R",
      batchId,
    });
    // local 那半被磁盘预检拒绝（copy 声明的体积超过剩余空间）
    await expect(
      manager.enqueueLocal({
        items: [
          {
            file: "rb.gguf",
            sourcePath: src,
            action: "copy",
            sameFs: false,
            size: Number.MAX_SAFE_INTEGER,
            sha256: "a".repeat(64),
          },
        ],
        targetDir: "hf/o/R",
        label: "o/R",
        batchId,
      }),
    ).rejects.toThrow(/磁盘空间不足/);

    // 撤回前：download 那半确实还占着落点（不撤就会 409）
    expect(taskRows(db).filter((r) => r.status === "downloading" || r.status === "pending")).toHaveLength(1);

    const cancelled = await manager.cancelBatch(batchId);
    expect(cancelled).toBe(1);
    expect(taskRows(db).every((r) => r.status === "cancelled")).toBe(true);

    // 重新提交同一批不再被「已有未完成的下载任务」挡住
    const retryRes = await manager.enqueueDownload({
      files: [{ file: "rb-remote.gguf", size: 10 }],
      targetDir: "hf/o/R",
      source: "hf",
      repo: "o/R",
      label: "o/R",
    });
    expect(retryRes.taskIds).toHaveLength(1);
  });

  it("cancelBatch 对已到终态的行是 no-op，也不误伤别的批次", async () => {
    const db = makeDb();
    const { manager, dl } = makeManager(db, root);
    await manager.enqueueDownload(hfArgs({ files: [{ file: "done.gguf", size: 10 }], batchId: "b-done" }));
    await runOneTask(dl); // 这批已完成
    await manager.enqueueDownload(hfArgs({ files: [{ file: "other.gguf", size: 10 }], batchId: "b-other" }));

    expect(await manager.cancelBatch("b-done")).toBe(0);
    expect(taskRows(db).find((r) => r.file === "done.gguf")!.status).toBe("completed");
    expect(taskRows(db).find((r) => r.file === "other.gguf")!.status).toBe("downloading");
  });

  it("同一 batchId 混合 download 与 local 任务，两者都完成后按批次统一归档", async () => {
    const db = makeDb();
    const { manager, dl } = makeManager(db, root);
    const batchId = "fixed-batch";
    const src = path.join(root, "loose/h.gguf");
    mkdirSync(path.dirname(src), { recursive: true });
    writeFileSync(src, "payload");
    const sha = createHash("sha256").update("payload").digest("hex");

    await manager.enqueueDownload({
      files: [{ file: "x.gguf", size: 10 }],
      targetDir: "hf/o/R",
      source: "hf",
      repo: "o/R",
      label: "o/R",
      batchId,
    });
    await manager.enqueueLocal({
      items: [{ file: "h.gguf", sourcePath: src, action: "move", sameFs: true, size: 7, sha256: sha }],
      targetDir: "hf/o/R",
      label: "o/R",
      batchId,
    });

    const rows = taskRows(db).filter((r) => r.batch_id === batchId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.source).sort()).toEqual(["hf", "local"]);
    // 单并发队列：download 任务先占了槽位，local 任务停在 pending 等待
    expect(rows.find((r) => r.source === "local")!.status).toBe("pending");

    await runOneTask(dl); // download 任务完成，接棒 local 任务（真实执行）
    await waitQueueIdle(manager);

    const finalRows = taskRows(db).filter((r) => r.batch_id === batchId);
    expect(finalRows.every((r) => r.status === "completed")).toBe(true);

    const history = historyRows(db).find((h) => h.batch_id === batchId);
    expect(history).toBeDefined();
    expect(history!.status).toBe("completed");
    const files = JSON.parse(history!.files) as { file: string }[];
    expect(files.map((f) => f.file).sort()).toEqual(["h.gguf", "x.gguf"]);
  });
});
