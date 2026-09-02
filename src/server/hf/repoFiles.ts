import type Database from "better-sqlite3";

import { groupRepoFiles, type QuantGroup } from "@/core/quant";
import { isStale, resolveTtlMs } from "@/lib/cache-freshness";
import { listRepoFiles, type HfOptions, type HfRepoFile } from "./client";

/**
 * 远端仓库文件清单拉取与缓存（档案详情页「文件」视图）
 *
 * 唯一碰 `repo_files_cache` 表的地方。**只缓存这一份远端量化清单**——档案详情页
 * 响应里另外四路（本地已有文件 / 散落文件 / 下载中任务 / 配置引用）一律保持
 * 实时计算，不进这张表也不进任何缓存：见 files/route.ts 头注释，缓存本地状态
 * 会让「刚下载完的文件」在页面上显示成「还没下载」。
 *
 * 形态照抄 hf/readme.ts 的缓存读写模式（同构，将来改一处能照着改另一处）：
 * - `refresh !== true` 且有缓存 → **立刻返回缓存**（不管新旧），`stale` 由
 *   TTL 判定给出。**不在这个函数里发起后台重取**——stale-while-revalidate 的
 *   「revalidate」那一半落在客户端：客户端拿到 `stale: true` 后自己带
 *   `?refresh=1` 再发一次请求，这样它才知道数据什么时候真的换了
 * - 无缓存（首次）→ 只能同步打 HF；成功落库，失败返回 `groups: null` + `error`
 * - `refresh === true` → 打 HF；成功落库并返回新数据；**失败时回落到旧缓存**，
 *   返回旧 `groups` + 旧 `fetchedAt` + `stale: true` + `error`——国内网络下
 *   HF 失败是常态，不能因为一次刷新失败就把用户已有的清单也弄没了
 */

export interface RemoteFilesCacheRow {
  repo: string;
  groups: QuantGroup[];
  fetchedAt: number;
}

export interface RemoteGroupsResult {
  /** null = 从来没有成功取过（无缓存又拉取失败） */
  groups: QuantGroup[] | null;
  /** 0 = 无缓存 */
  fetchedAt: number;
  stale: boolean;
  /** 本次取远端失败时的原因；有缓存时同时给出 groups（旧数据）与这个字段 */
  error: string | null;
}

export interface GetRemoteGroupsOptions {
  hf: HfOptions;
  /** true 表示绕过缓存强制重取（「刷新」按钮 / 客户端 SWR 的后台重取） */
  refresh?: boolean;
  /** 测试注入点；生产不传，走 client.ts 的 listRepoFiles */
  listRepoFiles?: (repo: string, opts?: HfOptions) => Promise<HfRepoFile[]>;
}

interface Row {
  repo: string;
  groups: string;
  fetched_at: number;
}

function toRow(row: Row): RemoteFilesCacheRow {
  return { repo: row.repo, groups: JSON.parse(row.groups) as QuantGroup[], fetchedAt: row.fetched_at };
}

export function readRemoteGroupsCache(db: Database.Database, repo: string): RemoteFilesCacheRow | null {
  const row = db.prepare("SELECT * FROM repo_files_cache WHERE repo = ?").get(repo) as Row | undefined;
  return row === undefined ? null : toRow(row);
}

function writeCache(db: Database.Database, repo: string, groups: QuantGroup[], fetchedAt: number): void {
  db.prepare(
    `INSERT INTO repo_files_cache(repo, groups, fetched_at)
     VALUES (?, ?, ?)
     ON CONFLICT(repo) DO UPDATE SET groups = excluded.groups, fetched_at = excluded.fetched_at`,
  ).run(repo, JSON.stringify(groups), fetchedAt);
}

export async function getRemoteGroups(
  db: Database.Database,
  repo: string,
  opts: GetRemoteGroupsOptions,
): Promise<RemoteGroupsResult> {
  const cached = readRemoteGroupsCache(db, repo);

  if (cached !== null && opts.refresh !== true) {
    const ttlMs = resolveTtlMs(process.env.PANEL_REPO_CACHE_TTL_HOURS);
    return {
      groups: cached.groups,
      fetchedAt: cached.fetchedAt,
      stale: isStale(cached.fetchedAt, Date.now(), ttlMs),
      error: null,
    };
  }

  const fetchRemote = opts.listRepoFiles ?? listRepoFiles;
  try {
    const files = await fetchRemote(repo, opts.hf);
    const groups = groupRepoFiles(files);
    const fetchedAt = Date.now();
    writeCache(db, repo, groups, fetchedAt);
    return { groups, fetchedAt, stale: false, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 有旧缓存就带出去（回落），无缓存就只能给一个空壳——两条分支的差别
    // 只在 groups/fetchedAt，error 与 stale 语义各自独立表达，见文件头注释
    if (cached !== null) {
      return { groups: cached.groups, fetchedAt: cached.fetchedAt, stale: true, error: message };
    }
    return { groups: null, fetchedAt: 0, stale: false, error: message };
  }
}
