import { listModels as hubListModels } from "@huggingface/hub";

import { isStale } from "@/lib/cache-freshness";
import {
  resolveTrendingTtlMs,
  toModelSummary,
  type HfModelSummary,
  type ModelEntryWithExtras,
} from "@/lib/hf-models";
import { makeProxyFetch, mapHfError, type HfOptions } from "./client";

/**
 * HF 模型发现的取数层（2026-09-21 设计 §6/§7）：唯一碰 `listModels` 的地方。
 *
 * 热门榜缓存在进程内存里而**不落 SQLite**：它是纯派生数据、12 条 JSON 不到 3KB、
 * 重启重取一秒，不值得为它加表加迁移。代价是面板重启后榜单空一下——它是锦上添花，
 * 不是 repo_files_cache 那种「丢了用户就看不见自己仓库文件」的数据。
 *
 * 与 repoFiles.ts 的一处**刻意差异**：那边命中缓存就立刻返回、不管新旧，把
 * revalidate 交给客户端再发一次请求；这边 TTL 过期就同步重取。因为两者代价不同——
 * 仓库文件清单要递归列一个仓库的全部文件（动辄几百条、要翻页），而榜单是一次
 * 12 条的请求，阻塞几百毫秒即可，不必让客户端跳两段舞。所以这里的 `stale` 只有
 * 一个含义：**这批是取远端失败后回落的旧数据**，与 TTL 无关。
 */

/** 404 在列表端点的真实含义：端点配错了，而不是「某个仓库没有」 */
const LIST_NOT_FOUND = "HF 接口不存在，请检查设置页的镜像端点";

export interface ListModelsResult {
  items: HfModelSummary[];
  /** 缓存写入时刻（epoch ms）；0 = 本次实时取得或彻底失败（搜索恒为 0） */
  fetchedAt: number;
  /** true = 这批是取远端失败后回落的旧数据 */
  stale: boolean;
  error: string | null;
}

/**
 * `listModels` 的最小调用形状。库的真实签名带泛型
 * `ResolveModelAdditionalFields<T>`，与本文件按结构声明的 ModelEntryWithExtras
 * 不会自动归一，因此在下方注入处做一次显式桥接——这是刻意的类型桥接，不是
 * 掩盖错误：运行时形状一致，且测试注入的假实现按这个签名写。
 */
export type ListModelsFn = (params: Record<string, unknown>) => AsyncIterable<ModelEntryWithExtras>;

export interface ListModelsDeps {
  hf: HfOptions;
  limit: number;
  /** true = 绕过缓存强制重取（route 的 ?refresh=1） */
  refresh?: boolean;
  /** 测试注入；生产不传，取 Date.now() */
  now?: number;
  /** 测试注入；生产不传，走 @huggingface/hub */
  listModels?: ListModelsFn;
}

interface CacheEntry {
  items: HfModelSummary[];
  fetchedAt: number;
}

const trendingCache = new Map<string, CacheEntry>();

/** 仅测试使用：清空进程内热门榜缓存（命名照 server/proxyAgentCache.ts 的先例） */
export function _resetTrendingCacheForTest(): void {
  trendingCache.clear();
}

function cacheKey(hf: HfOptions, limit: number): string {
  return `${hf.endpoint ?? "official"}::${limit}`;
}

async function collect(query: string | undefined, deps: ListModelsDeps): Promise<HfModelSummary[]> {
  const run: ListModelsFn = deps.listModels ?? (hubListModels as unknown as ListModelsFn);
  const items: HfModelSummary[] = [];

  for await (const entry of run({
    hubUrl: deps.hf.endpoint,
    accessToken: deps.hf.token,
    fetch: deps.hf.proxy ? makeProxyFetch(deps.hf.proxy) : undefined,
    sort: "trendingScore",
    limit: deps.limit,
    search: query === undefined ? { tags: ["gguf"] } : { tags: ["gguf"], query },
    // 只要 trendingScore：pipeline_tag 与 lastModified 已在库内置的 expand 里，
    // 重复传会让 HF 报 Array elements must be unique 直接 400（2026-09-21 实测）
    additionalFields: ["trendingScore"],
  })) {
    items.push(toModelSummary(entry));
    // listModels 是 async generator，自身会跟着 Link 头翻页；这里到量即断，
    // 不让它替我们多翻一页
    if (items.length >= deps.limit) break;
  }

  return items;
}

export async function getTrendingModels(deps: ListModelsDeps): Promise<ListModelsResult> {
  const now = deps.now ?? Date.now();
  const key = cacheKey(deps.hf, deps.limit);
  const cached = trendingCache.get(key);
  const ttlMs = resolveTrendingTtlMs(process.env.PANEL_HF_TRENDING_TTL_MINUTES);

  if (cached !== undefined && deps.refresh !== true && !isStale(cached.fetchedAt, now, ttlMs)) {
    return { items: cached.items, fetchedAt: cached.fetchedAt, stale: false, error: null };
  }

  try {
    const items = await collect(undefined, deps);
    trendingCache.set(key, { items, fetchedAt: now });
    return { items, fetchedAt: now, stale: false, error: null };
  } catch (e) {
    const message = mapHfError(e, { notFound: LIST_NOT_FOUND }).message;
    // 刷新失败不许把用户正看着的榜单弄没：有旧值就带出去并标 stale，缓存本身不动
    if (cached !== undefined) {
      return { items: cached.items, fetchedAt: cached.fetchedAt, stale: true, error: message };
    }
    return { items: [], fetchedAt: 0, stale: false, error: message };
  }
}

/** 搜索结果不缓存：查询空间无限，压请求量靠前端 debounce（设计 §7） */
export async function searchModels(query: string, deps: ListModelsDeps): Promise<ListModelsResult> {
  try {
    const items = await collect(query, deps);
    return { items, fetchedAt: 0, stale: false, error: null };
  } catch (e) {
    return {
      items: [],
      fetchedAt: 0,
      stale: false,
      error: mapHfError(e, { notFound: LIST_NOT_FOUND }).message,
    };
  }
}
