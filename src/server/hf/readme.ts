import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

import { extractRecommendations } from "@/lib/readme-params";
import { splitFrontmatter } from "@/lib/readme-frontmatter";
import { makeProxyFetch, type HfOptions } from "./client";

/**
 * README 拉取与缓存（HF README 视图）
 *
 * 唯一碰 `repo_readme` 表的地方。取数复用 hf/client.ts 的三源配置
 * （Token / 镜像 / 出站代理），URL 拼法与 download/manager.ts 的
 * `${base}/${repo}/resolve/main/${file}` 同款——镜像站实测同样支持
 * `/raw/main/README.md` 与 `/resolve/main/README.md`，不需要为 README 单开回落。
 *
 * **失败落不落库是这个模块最要紧的判断**：
 * - 200 → 落库（含 sha，内容变了让 profiles 失效）
 * - 404 → 落一行 `content IS NULL`，语义是「问过了，这个仓库确实没有 README」，
 *   于是不会每次进页面都为一个注定 404 的请求等一次网络往返
 * - 401/403/网络/5xx → **不落库**。若把失败也写进 `fetched_at`，「缓存为空才自动拉」
 *   的判定会把一次网络抖动变成永久空白，用户填完 Token 回来也看不到变化
 */

/** 原文上限：调研语料里最大的一份 65 KB，留 4 倍余量 */
export const MAX_README_BYTES = 256 * 1024;

/** 抽取器版本。改动 lib/readme-params.ts 及其上游 readme-cli-block.ts /
 *  readme-kv.ts 的抽取规则后必须在这里 bump 一次，让已缓存的 README 下次拉取
 *  （含点击「刷新」）时用新规则重新解析——否则已落库的旧结果只按内容 sha
 *  判断是否失效，规则改了但内容没变就会被永久沿用，新规则等于白改。 */
export const PROFILES_ENGINE = "rules-v1";

export type ReadmeErrorKind = "notFound" | "unauthorized" | "network";

export interface ReadmeCacheRow {
  repo: string;
  /** 原文（含 frontmatter）；null = 该仓库没有 README */
  content: string | null;
  contentSha: string | null;
  /** RecommendedProfile[] 的 JSON 文本；P3 之前恒为 null */
  profiles: string | null;
  profilesEngine: string | null;
  truncated: boolean;
  fetchedAt: number;
  parsedAt: number | null;
}

export interface ReadmeResult extends ReadmeCacheRow {
  error: { kind: ReadmeErrorKind; message: string } | null;
}

export interface GetReadmeOptions {
  hf: HfOptions;
  /** true 表示绕过缓存强制重取（「刷新」按钮） */
  refresh?: boolean;
  /** 测试注入点；生产不传，按 hf.proxy 决定用代理 fetch 还是全局 fetch */
  fetchImpl?: typeof fetch;
}

interface Row {
  repo: string;
  content: string | null;
  content_sha: string | null;
  profiles: string | null;
  profiles_engine: string | null;
  truncated: number;
  fetched_at: number;
  parsed_at: number | null;
}

function toRow(row: Row): ReadmeCacheRow {
  return {
    repo: row.repo,
    content: row.content,
    contentSha: row.content_sha,
    profiles: row.profiles,
    profilesEngine: row.profiles_engine,
    truncated: row.truncated === 1,
    fetchedAt: row.fetched_at,
    parsedAt: row.parsed_at,
  };
}

export function readReadmeCache(db: Database.Database, repo: string): ReadmeCacheRow | null {
  const row = db.prepare("SELECT * FROM repo_readme WHERE repo = ?").get(repo) as Row | undefined;
  return row === undefined ? null : toRow(row);
}

class ReadmeFetchError extends Error {
  constructor(
    readonly kind: ReadmeErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ReadmeFetchError";
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 拉原文；失败一律抛 ReadmeFetchError（带分类），由 getReadme 决定落不落库 */
async function fetchReadme(
  repo: string,
  opts: HfOptions,
  fetchImpl?: typeof fetch,
): Promise<{ content: string; truncated: boolean }> {
  const base = (opts.endpoint ?? "https://huggingface.co").replace(/\/+$/, "");
  const url = `${base}/${repo}/resolve/main/README.md`;
  const doFetch = fetchImpl ?? (opts.proxy ? makeProxyFetch(opts.proxy) : fetch);

  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;

  let res: Response;
  try {
    res = await doFetch(url, { headers, redirect: "follow" });
  } catch (error) {
    throw new ReadmeFetchError(
      "network",
      `拉取 README 失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (res.status === 404) throw new ReadmeFetchError("notFound", `仓库没有 README: ${repo}`);
  if (res.status === 401 || res.status === 403) {
    throw new ReadmeFetchError("unauthorized", "该仓库受限，需要有权限的 HF Token");
  }
  if (!res.ok) throw new ReadmeFetchError("network", `拉取 README 失败: HTTP ${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer());
  const truncated = buf.byteLength > MAX_README_BYTES;
  // 截断按字节切，末尾可能砍断一个多字节字符——TextDecoder 非 fatal 模式会把它
  // 替换成 U+FFFD，一个替换符换来一个恒定的内存上限，划算
  const content = new TextDecoder("utf-8").decode(
    truncated ? buf.subarray(0, MAX_README_BYTES) : buf,
  );
  return { content, truncated };
}

/** 空壳记录：无缓存又拉失败时返回它 + error，让 UI 有一致的形状可渲染 */
function emptyRow(repo: string): ReadmeCacheRow {
  return {
    repo,
    content: null,
    contentSha: null,
    profiles: null,
    profilesEngine: null,
    truncated: false,
    fetchedAt: 0,
    parsedAt: null,
  };
}

export async function getReadme(
  db: Database.Database,
  repo: string,
  opts: GetReadmeOptions,
): Promise<ReadmeResult> {
  const cached = readReadmeCache(db, repo);
  if (cached !== null && opts.refresh !== true) return { ...cached, error: null };

  try {
    const { content, truncated } = await fetchReadme(repo, opts.hf, opts.fetchImpl);
    const contentSha = sha256(content);
    // 内容没变、且抽取规则也没升级过，就保留已有的解析结果——重算一遍得到的是
    // 同一份东西，而丢掉它会让 P3 的推荐卡在每次刷新后闪一下空。
    // **`opts.refresh === true` 时一律不复用**：用户点「刷新」就该重算，这符合
    // 按钮的字面承诺——否则已缓存过的仓库会永远显示旧结果，没有任何用户可达
    // 的手段能让它重算（进入本函数体这段逻辑的唯一两条路：首次拉取 `cached`
    // 为 null，或显式刷新绕过了上面的缓存早返回，两种情形下都不该沿用旧值）
    const reusable =
      cached !== null &&
      cached.contentSha === contentSha &&
      cached.profilesEngine === PROFILES_ENGINE &&
      opts.refresh !== true;
    // 不可复用就当场重跑一次——抽取是纯 CPU、毫秒级，不值得为它单开一条异步路径
    const profiles = reusable
      ? cached.profiles
      : JSON.stringify(extractRecommendations(splitFrontmatter(content).body));
    const profilesEngine = reusable ? cached.profilesEngine : PROFILES_ENGINE;
    const parsedAt = reusable ? cached.parsedAt : Date.now();
    const fetchedAt = Date.now();

    db.prepare(
      `INSERT INTO repo_readme(repo, content, content_sha, profiles, profiles_engine,
                               truncated, fetched_at, parsed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo) DO UPDATE SET
         content = excluded.content, content_sha = excluded.content_sha,
         profiles = excluded.profiles, profiles_engine = excluded.profiles_engine,
         truncated = excluded.truncated, fetched_at = excluded.fetched_at,
         parsed_at = excluded.parsed_at`,
    ).run(repo, content, contentSha, profiles, profilesEngine, truncated ? 1 : 0, fetchedAt, parsedAt);

    return {
      repo,
      content,
      contentSha,
      profiles,
      profilesEngine,
      truncated,
      fetchedAt,
      parsedAt,
      error: null,
    };
  } catch (error) {
    const kind: ReadmeErrorKind =
      error instanceof ReadmeFetchError ? error.kind : "network";
    const message = error instanceof Error ? error.message : String(error);

    if (kind === "notFound") {
      const fetchedAt = Date.now();
      db.prepare(
        `INSERT INTO repo_readme(repo, content, content_sha, profiles, profiles_engine,
                                 truncated, fetched_at, parsed_at)
         VALUES (?, NULL, NULL, NULL, NULL, 0, ?, NULL)
         ON CONFLICT(repo) DO UPDATE SET
           content = NULL, content_sha = NULL, profiles = NULL, profiles_engine = NULL,
           truncated = 0, fetched_at = excluded.fetched_at, parsed_at = NULL`,
      ).run(repo, fetchedAt);
      return { ...emptyRow(repo), fetchedAt, error: { kind, message } };
    }

    // 其余失败不落库：下次进页面自动重试（见文件头注）
    return { ...(cached ?? emptyRow(repo)), error: { kind, message } };
  }
}
