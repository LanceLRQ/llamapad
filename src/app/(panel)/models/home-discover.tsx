"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Loader2, RefreshCw, Search, X } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";

import { NewDownloadDialog } from "@/components/downloads/new-download-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import {
  HF_DISCOVER_LIMIT,
  buildDiscoverQuery,
  hasMoreResults,
  hfListUrl,
  OFFICIAL_HF_ENDPOINT,
  type HfModelsResponse,
} from "@/lib/hf-models";
import { DiscoverCard } from "./discover-card";

/** 搜索输入的防抖时长（毫秒）：压 HF 请求量，见设计 §7 */
const SEARCH_DEBOUNCE_MS = 400;

/**
 * 「已经落定的那一次取数」。查询词与结果**存在同一个 state 里**，是为了让区标题、
 * 卡片网格、通栏「更多」按钮三者在任何时刻都描述同一批数据：若标题读正在防抖的
 * `submitted`、卡片读上一批 payload，那么在 400ms~2s 的取数窗口里标题已经是
 * 「搜索结果 · qwen」、下面还是热门榜的 12 张卡、按钮也已指向搜索 URL，三者互相矛盾。
 * 反过来「切换时清空结果」也不行——那会让每次敲键都闪成一屏骨架。
 */
interface SettledResult {
  /** 产出这批数据的查询词；空串 = 热门态 */
  query: string;
  payload: HfModelsResponse | null;
  failure: string | null;
}

/**
 * 模型首页「HuggingFace 热门」区（2026-09-21 HF 模型发现设计 §9）。
 *
 * 取数走客户端而不是 RSC：/models 是 force-dynamic 服务端页，若在服务端取 HF，
 * 网络不通时整页会卡在超时上，把「正在运行」「最近更新的仓库」两区一起拖垮。
 *
 * 搜索词**不写进 URL**：这块是首页的一个探索入口，不是可分享可回退的独立页面；
 * 把词写进 URL 会让浏览器「后退」变成在首页内部翻搜索历史，与「后退应离开首页」
 * 的直觉相悖。
 */
export function HomeDiscover({
  ownedRepos,
  folders,
}: {
  /** 本地已建档案的 repo → 档案 id，用于卡片上的「已有档案」徽标 */
  ownedRepos: Record<string, number>;
  folders: string[];
}) {
  const t = useTranslations("pages.modelsHome.discover");
  const format = useFormatter();

  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [settled, setSettled] = useState<SettledResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloadRepo, setDownloadRepo] = useState<string | null>(null);
  /** 刷新计数：自增一次即触发下方取数 effect 重跑（事件处理器里的函数式
   *  setState，与 new-download-dialog.tsx 的 setGeneration 同款写法） */
  const [reload, setReload] = useState(0);
  /** 「下一次取数是用户主动刷新」的一次性标记，取数落定即销（见下方 finally）。
   *  刻意用 ref 而不是拿上面那个计数器判：计数器只增不减，`reload > 0` 的含义是
   *  「此生点过刷新」而不是「这次是刷新」，据此拼 refresh=1 会让用户点过一次刷新
   *  之后、此后每次回到热门态都绕过缓存打网络（设计 §7 那层 30 分钟缓存就白建了） */
  const forceNextLoad = useRef(false);

  // 输入防抖：只把停止输入 400ms 之后的词提交给下面那个取数 effect
  useEffect(() => {
    const timer = setTimeout(() => setSubmitted(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // 取数：submitted 变化或点刷新时重跑，旧请求用 AbortController 中止，
  // 避免迟到的响应覆盖新结果
  useEffect(() => {
    const controller = new AbortController();

    async function load(signal: AbortSignal): Promise<void> {
      setLoading(true);
      const force = forceNextLoad.current;
      const search = buildDiscoverQuery({ query: submitted, limit: HF_DISCOVER_LIMIT, force });

      try {
        const res = await apiFetch(`/api/v1/hf/models?${search}`, { signal, cache: "no-store" });
        const body = (await res.json()) as HfModelsResponse & { error?: string };
        if (signal.aborted) return;
        if (!res.ok) {
          setSettled({ query: submitted, payload: null, failure: body.error ?? "unknown" });
        } else {
          setSettled({ query: submitted, payload: body, failure: null });
        }
      } catch (error) {
        if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
        setSettled({
          query: submitted,
          payload: null,
          failure: error instanceof Error ? error.message : String(error),
        });
      } finally {
        // 落定即销标记：刷新是一次性动作，不能留成持久状态。放在这里而不是读完就置回，
        // 是为了扛住 abort 竞态——刷新请求在途时若用户又开始输入，这一跑会被中止、
        // 由新的一跑接替，而"这次是主动刷新"的语义应该跟着延续下去。被中止的那一跑
        // 不销标记，只有真正跑完的那一跑才销
        if (!signal.aborted) {
          forceNextLoad.current = false;
          setLoading(false);
        }
      }
    }

    void load(controller.signal);
    return () => controller.abort();
  }, [submitted, reload]);

  /** 区头 [↻] 与失败态「重试」共用：标记这一次是主动刷新，再撞一下计数器触发重跑 */
  function requestRefresh(): void {
    forceNextLoad.current = true;
    setReload((n) => n + 1);
  }

  const payload = settled?.payload ?? null;
  const failure = settled?.failure ?? null;
  /** 当前这批数据是哪个词产出的（不是输入框里正在敲的那个） */
  const shownQuery = settled?.query ?? "";
  const endpoint = payload?.endpoint ?? OFFICIAL_HF_ENDPOINT;
  const items = payload?.items ?? [];
  const showMore = hasMoreResults(items.length, HF_DISCOVER_LIMIT);

  return (
    <section className="px-7 pb-10">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">
          {shownQuery === "" ? t("title") : t("searchTitle", { query: shownQuery })}
        </h2>
        <div className="flex items-center gap-1">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("searchPlaceholder")}
              className="h-8 w-56 pl-8"
            />
            {query !== "" && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title={t("clear")}
                aria-label={t("clear")}
                className="absolute top-1/2 right-1 -translate-y-1/2"
                onClick={() => setQuery("")}
              >
                <X className="size-3.5" />
              </Button>
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title={t("refresh")}
            aria-label={t("refresh")}
            disabled={loading}
            onClick={requestRefresh}
          >
            {loading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
          </Button>
        </div>
      </div>

      {payload?.stale === true && payload.error !== null && (
        <p className="mb-2 text-xs text-amber-600 dark:text-amber-400">
          {/* fetchedAt 不必防 0：stale 只可能出自「热门榜有旧缓存、本次取远端失败」那一条
              路径（server/hf/models.ts 的 catch + cached 分支），该路径回的恒是缓存写入
              时刻（写入时取的 Date.now()，必 > 0）；searchModels 永不返回 stale */}
          {t("staleHint", { ago: format.relativeTime(payload.fetchedAt), reason: payload.error })}
        </p>
      )}

      {loading && items.length === 0 ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Card key={i}>
              <CardContent className="flex flex-col gap-2">
                <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
                <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
                <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
                <div className="h-8 w-full animate-pulse rounded bg-muted" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : failure !== null ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <p className="max-w-lg text-sm text-muted-foreground">
              {t("loadFailed", { reason: failure })}
            </p>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={requestRefresh}>
                {t("retry")}
              </Button>
              <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/settings" />}>
                {t("gotoSettings")}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            {/* 热门态与搜索态分开措辞：镜像端点坏掉返回 [] 时，一句「换个关键词试试」
                会把配置问题伪装成搜索无果，而此时用户根本没输入过关键词 */}
            <p className="text-sm font-medium">
              {shownQuery === "" ? t("emptyTrendingTitle") : t("emptyTitle")}
            </p>
            <p className="max-w-md text-sm text-muted-foreground">
              {shownQuery === "" ? t("emptyTrendingHint") : t("emptyHint")}
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((model) => (
              <DiscoverCard
                key={model.repo}
                model={model}
                endpoint={endpoint}
                ownedProfileId={ownedRepos[model.repo] ?? null}
                onDownload={setDownloadRepo}
              />
            ))}
          </div>
          {showMore && (
            <Button
              variant="outline"
              className="mt-3 w-full"
              nativeButton={false}
              render={
                <a
                  href={hfListUrl(shownQuery, endpoint)}
                  target="_blank"
                  rel="noopener noreferrer"
                />
              }
            >
              {t("viewMore")}
              <ArrowUpRight className="size-3.5" />
            </Button>
          )}
        </>
      )}

      <NewDownloadDialog
        open={downloadRepo !== null}
        onOpenChange={(next) => {
          if (!next) setDownloadRepo(null);
        }}
        folders={folders}
        defaultRepo={downloadRepo ?? undefined}
        repoOnly
      />
    </section>
  );
}
