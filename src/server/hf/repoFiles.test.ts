import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";

import { openDb, runMigrations } from "../db";
import { groupRepoFiles, type QuantGroup } from "@/core/quant";
import type { HfRepoFile } from "./client";
import { getRemoteGroups, readRemoteGroupsCache } from "./repoFiles";

let db: Database.Database;

beforeEach(() => {
  db = openDb(":memory:");
  runMigrations(db);
});

/** 造一份远端文件清单：一个量化对应一个单文件模型 */
const rawFiles = (quant: string): HfRepoFile[] => [{ path: `model.${quant}.gguf`, size: 100 }];
/** 期望的分组结果直接走真实的 groupRepoFiles，不重复维护一份规则 */
const groups = (quant: string): QuantGroup[] => groupRepoFiles(rawFiles(quant));

describe("getRemoteGroups", () => {
  it("首次拉取写入缓存并回内容", async () => {
    const hf = vi.fn().mockResolvedValue(rawFiles("Q4_K_M"));
    const res = await getRemoteGroups(db, "o/r", { hf: {}, listRepoFiles: hf });

    expect(res.groups).toEqual(groups("Q4_K_M"));
    expect(res.error).toBeNull();
    expect(res.stale).toBe(false);
    expect(readRemoteGroupsCache(db, "o/r")?.groups).toEqual(groups("Q4_K_M"));
  });

  it("命中缓存时不再打网络（不管新旧，立刻返回缓存）", async () => {
    const hf = vi.fn().mockResolvedValue(rawFiles("Q4_K_M"));
    await getRemoteGroups(db, "o/r", { hf: {}, listRepoFiles: hf });
    const res = await getRemoteGroups(db, "o/r", { hf: {}, listRepoFiles: hf });

    expect(hf).toHaveBeenCalledTimes(1);
    expect(res.groups).toEqual(groups("Q4_K_M"));
  });

  it("命中缓存时不在服务端后台重取，即使已过期", async () => {
    const hf = vi.fn().mockResolvedValue(rawFiles("Q4_K_M"));
    await getRemoteGroups(db, "o/r", { hf: {}, listRepoFiles: hf });
    db.prepare("UPDATE repo_files_cache SET fetched_at = ? WHERE repo = ?").run(1, "o/r");

    const res = await getRemoteGroups(db, "o/r", { hf: {}, listRepoFiles: hf });
    expect(hf).toHaveBeenCalledTimes(1);
    expect(res.stale).toBe(true);
    expect(res.groups).toEqual(groups("Q4_K_M"));
  });

  it("无缓存时首次拉取失败，返回 groups: null 与 error", async () => {
    const hf = vi.fn().mockRejectedValue(new Error("网络错误"));
    const res = await getRemoteGroups(db, "o/r", { hf: {}, listRepoFiles: hf });

    expect(res.groups).toBeNull();
    expect(res.error).toBe("网络错误");
    expect(res.fetchedAt).toBe(0);
    expect(readRemoteGroupsCache(db, "o/r")).toBeNull();
  });

  it("refresh=true 打网络成功则落库并返回新数据", async () => {
    const hf = vi.fn().mockResolvedValue(rawFiles("Q4_K_M"));
    await getRemoteGroups(db, "o/r", { hf: {}, listRepoFiles: hf });

    const hf2 = vi.fn().mockResolvedValue(rawFiles("Q8_0"));
    const res = await getRemoteGroups(db, "o/r", { hf: {}, refresh: true, listRepoFiles: hf2 });

    expect(hf2).toHaveBeenCalledTimes(1);
    expect(res.groups).toEqual(groups("Q8_0"));
    expect(res.stale).toBe(false);
    expect(res.error).toBeNull();
    expect(readRemoteGroupsCache(db, "o/r")?.groups).toEqual(groups("Q8_0"));
  });

  it("refresh=true 打网络失败时回落到旧缓存，stale=true 且带出 error", async () => {
    const hf = vi.fn().mockResolvedValue(rawFiles("Q4_K_M"));
    await getRemoteGroups(db, "o/r", { hf: {}, listRepoFiles: hf });
    const oldFetchedAt = readRemoteGroupsCache(db, "o/r")?.fetchedAt;

    const failing = vi.fn().mockRejectedValue(new Error("HF 限流"));
    const res = await getRemoteGroups(db, "o/r", { hf: {}, refresh: true, listRepoFiles: failing });

    expect(res.groups).toEqual(groups("Q4_K_M"));
    expect(res.fetchedAt).toBe(oldFetchedAt);
    expect(res.stale).toBe(true);
    expect(res.error).toBe("HF 限流");
    // 旧缓存本身不被这次失败的刷新污染
    expect(readRemoteGroupsCache(db, "o/r")?.groups).toEqual(groups("Q4_K_M"));
  });

  it("refresh=true 且无缓存又拉取失败，返回 groups: null 与 error", async () => {
    const failing = vi.fn().mockRejectedValue(new Error("网络错误"));
    const res = await getRemoteGroups(db, "o/r", { hf: {}, refresh: true, listRepoFiles: failing });

    expect(res.groups).toBeNull();
    expect(res.error).toBe("网络错误");
    expect(res.stale).toBe(false);
  });
});
