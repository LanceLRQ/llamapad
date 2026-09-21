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
  /** 这批数据的取得时刻（epoch ms）：热门榜实时取得时是本次取数时刻、回落旧缓存时是
   *  缓存写入时刻，两者都非 0；只有搜索（不缓存）与彻底失败（没有旧缓存可回落）才是 0 */
  fetchedAt: number;
  /** true = 这批是取远端失败后回落的旧数据 */
  stale: boolean;
  error: string | null;
}

/**
 * `listModels` 的调用参数，只列本模块真正会传的那几项。刻意**不 import
 * `@huggingface/hub` 的类型**（理由同 lib/hf-models.ts 的头注释），但也不写成
 * `Record<string, unknown>`——那等于把整个请求参数对象的类型检查全扔了：`sort`
 * 拼错、`search` 结构写错、`additionalFields` 传成字符串，tsc 一律放行，只有真机
 * 400 才暴露，而「多传一个字段就被 HF 判 400」恰恰是设计 §3 记下的坑。
 */
export interface ListModelsParams {
  /** hub API 基址；undefined = 官方站 */
  hubUrl?: string;
  accessToken?: string;
  /** 代理注入点；undefined = 走全局 fetch */
  fetch?: typeof fetch;
  sort: "trendingScore";
  limit: number;
  /** tags 固定 ["gguf"]；query 只有搜索态才带 */
  search: { tags: string[]; query?: string };
  additionalFields: string[];
}

/** `listModels` 的最小调用形状；测试注入的假实现按这个签名写 */
export type ListModelsFn = (params: ListModelsParams) => AsyncIterable<ModelEntryWithExtras>;

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
  // `as unknown as` 是刻意的类型桥接，不是掩盖错误：库的 `additionalFields` 形参类型
  // `ModelAdditionalField` 派生自 `MODEL_EXPANDABLE_KEYS`，而那个数组的 21 个键里**没有**
  // `trendingScore`（2026-09-21 打印实测），`ModelDerivedFields` 也只有 `filePaths`——
  // 于是 `additionalFields: ["trendingScore"]` 根本不是库签名的合法实参，把注入点标成
  // `typeof hubListModels` 在 tsc 下过不去。运行时没问题：库把未知字段原样拼进 `expand=`
  // 再原样回填（list-models.ts 的 additionalExpandKeys 分支）。
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
    // 防御性上限，不依赖库的截断行为：库传了 limit 时自己就会 totalToFetch-- 并提前
    // return，首页请求也已按 Math.min(limit, 500) 限量，这里到量即断只是不把上游的
    // 截断语义当成前提——万一哪天它改了，整份 Link 翻页也不会被拉进内存
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
