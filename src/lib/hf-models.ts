/**
 * HF 模型发现的纯判定层（2026-09-21 设计 §8）：响应体映射、外链组装、TTL 解析、
 * 满屏判定、查询参数解析。vitest 是 node 环境、没有 jsdom，组件测不了，可测判定
 * 一律下沉到这里（见 CLAUDE.md「工具链」一节）。
 *
 * 本模块被客户端组件 import，因此**刻意不依赖 `@huggingface/hub`**：入参用下方的
 * 结构类型 ModelEntryWithExtras 声明，把那个纯服务端的库挡在浏览器 bundle 之外。
 */

/** 首页发现区一屏的条数；route 与客户端共用同一个常量，避免「客户端按 12 判满屏、
 *  服务端按 20 返回」这类两侧错位 */
export const HF_DISCOVER_LIMIT = 12;

/** limit 上限：拦住手改查询串拉一大页把 HF 限流打满 */
export const HF_DISCOVER_MAX_LIMIT = 50;

/** 设置页 hf_mirror 未设置（或设为 official）时的站点根 */
export const OFFICIAL_HF_ENDPOINT = "https://huggingface.co";

/** 热门榜缓存默认存活时长（分钟）。单位刻意是分钟而非 cache-freshness 的小时：
 *  榜单的自然量级就是分钟，写成小时会让环境变量在两处含义不一致，见设计 §7 */
export const DEFAULT_TRENDING_TTL_MINUTES = 30;

const MINUTE_MS = 60_000;

/** 面板展示用的单个模型条目（GET /api/v1/hf/models 的响应项） */
export interface HfModelSummary {
  /** 完整 repo id，如 "unsloth/Qwen3.8-27B-GGUF" */
  repo: string;
  owner: string;
  name: string;
  likes: number;
  downloads: number;
  /** 搜索结果里 HF 不一定给，缺省为 null */
  trending: number | null;
  /** pipeline_tag，如 "text-generation" */
  task: string | null;
  /** epoch ms；无法解析时为 0，由卡片判空不显示 */
  updatedAt: number;
  gated: boolean;
}

/**
 * `GET /api/v1/hf/models` 的响应体（设计 §5）。route 用 `satisfies` 钉住返回形状、
 * 客户端组件直接 import 同一份声明——两侧共用一个类型，免得各写一份日后悄悄分叉。
 */
export interface HfModelsResponse {
  items: HfModelSummary[];
  /** 生效站点根，如 "https://hf-mirror.com"；外链与「更多」按钮都用它组装 */
  endpoint: string;
  /** 这批数据的取得时刻（epoch ms）：热门榜为实时取数或缓存写入时刻，搜索恒为 0 */
  fetchedAt: number;
  /** true = 这批是取远端失败后回落的旧数据 */
  stale: boolean;
  /** 回落时带上失败原因；成功为 null */
  error: string | null;
}

/**
 * `listModels` 产出条目的最小结构（库里叫 `ModelEntry`，
 * `@huggingface/hub/src/lib/list-models.ts:57`，叠加 additionalFields 透传的
 * `trendingScore`）。按结构类型声明而不 import 库的类型，理由见文件头注释。
 *
 * 三处易错点都在这个类型里（2026-09-21 实测，见设计 §3）：`updatedAt` 是真正的
 * `Date` 对象不是字符串；`gated` 是三值枚举不是布尔；`task` 可选。
 */
export interface ModelEntryWithExtras {
  name: string;
  likes: number;
  downloads: number;
  gated: false | "auto" | "manual";
  task?: string;
  updatedAt: Date | string;
  trendingScore?: number;
}

export function toModelSummary(raw: ModelEntryWithExtras): HfModelSummary {
  const slash = raw.name.indexOf("/");
  const parsed = new Date(raw.updatedAt).getTime();
  return {
    repo: raw.name,
    owner: slash === -1 ? "" : raw.name.slice(0, slash),
    name: slash === -1 ? raw.name : raw.name.slice(slash + 1),
    likes: raw.likes,
    downloads: raw.downloads,
    trending: raw.trendingScore ?? null,
    task: raw.task ?? null,
    updatedAt: Number.isNaN(parsed) ? 0 : parsed,
    // gated 是 false | "auto" | "manual"：两种非 false 值都表示需要在 HF 页面申请
    gated: raw.gated !== false,
  };
}

function trimTrailingSlash(endpoint: string): string {
  return endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
}

/** 单仓库外链：`<endpoint>/<repo>` */
export function hfRepoUrl(repo: string, endpoint: string): string {
  return `${trimTrailingSlash(endpoint)}/${repo}`;
}

/**
 * 站内列表页外链（通栏「更多」按钮）。
 *
 * `other=gguf` 而不是 `library=gguf`：前者与 API 的 `filter=gguf` 同为标签筛选，
 * 口径一一对应，面板列出的与点过去看到的是同一批（两者 2026-09-21 实测均 200）。
 *
 * 搜索态刻意不带 `sort`：HF 站内搜索默认按相关度排，压成 trending 反而更差。
 */
export function hfListUrl(query: string, endpoint: string): string {
  const base = `${trimTrailingSlash(endpoint)}/models`;
  const trimmed = query.trim();
  if (trimmed === "") return `${base}?other=gguf&sort=trending`;
  return `${base}?search=${encodeURIComponent(trimmed)}&other=gguf`;
}

/**
 * TTL 环境变量（分钟）→ 毫秒。`0` = 永不自动过期；负数 / 非数字 / 空串一律回落
 * 默认值而**不抛异常**——一个写错的环境变量不该让面板起不来（与
 * lib/cache-freshness.ts 的 resolveTtlMs 同款容错策略，只是单位不同）。
 */
export function resolveTrendingTtlMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_TRENDING_TTL_MINUTES * MINUTE_MS;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) return DEFAULT_TRENDING_TTL_MINUTES * MINUTE_MS;
  if (minutes === 0) return Number.POSITIVE_INFINITY;
  return minutes * MINUTE_MS;
}

/** 满屏判定：面板不做翻页，返回条数够一屏就认为 HF 那边还有更多，给通栏按钮 */
export function hasMoreResults(count: number, limit: number): boolean {
  return count >= limit;
}

/**
 * 发现区请求串组装。`force` 表示「这一次是用户主动刷新」，是一次性动作而不是持久
 * 状态——把它做成参数而不是让组件读自己的刷新计数器，是因为计数器只增不减，
 * `reload > 0` 的真实含义是「此生点过刷新」而非「这次是刷新」，据此拼 refresh=1
 * 会让用户点过一次刷新之后、此后每次回到热门态都绕过缓存打网络（该缺陷已发生过
 * 一次）。搜索本就不缓存，所以搜索态即使 force 也不带 refresh，带了无意义。
 */
export function buildDiscoverQuery(opts: {
  query: string;
  limit: number;
  force: boolean;
}): string {
  const trimmed = opts.query.trim();
  const params = new URLSearchParams({ limit: String(opts.limit) });
  if (trimmed !== "") params.set("q", trimmed);
  else if (opts.force) params.set("refresh", "1");
  return params.toString();
}

/**
 * 查询串 limit 解析。非整数 / <1 静默回落默认值而不是 400：limit 只是展示条数，
 * 一个写错的查询串不该让整块区域报错（与 api/v1/events 的既有做法一致）。
 */
export function parseLimit(raw: string | null): number {
  if (raw === null) return HF_DISCOVER_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return HF_DISCOVER_LIMIT;
  return Math.min(parsed, HF_DISCOVER_MAX_LIMIT);
}
