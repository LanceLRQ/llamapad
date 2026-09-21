"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, Loader2, RefreshCw, Search, X } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { NewDownloadDialog } from "@/components/downloads/new-download-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import {
  HF_DISCOVER_LIMIT,
  hasMoreResults,
  hfListUrl,
  OFFICIAL_HF_ENDPOINT,
  type HfModelSummary,
} from "@/lib/hf-models";
import { DiscoverCard } from "./discover-card";

/** 搜索输入的防抖时长（毫秒）：压 HF 请求量，见设计 §7 */
const SEARCH_DEBOUNCE_MS = 400;

interface Payload {
  items: HfModelSummary[];
  endpoint: string;
  fetchedAt: number;
  stale: boolean;
  error: string | null;
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

  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [downloadRepo, setDownloadRepo] = useState<string | null>(null);
  /** 刷新计数：自增一次即触发下方取数 effect 重跑（事件处理器里的函数式
   *  setState，与 new-download-dialog.tsx 的 setGeneration 同款写法） */
  const [reload, setReload] = useState(0);

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
      setFailure(null);
      const params = new URLSearchParams({ limit: String(HF_DISCOVER_LIMIT) });
      if (submitted !== "") params.set("q", submitted);
      if (reload > 0 && submitted === "") params.set("refresh", "1");

      try {
        const res = await apiFetch(`/api/v1/hf/models?${params.toString()}`, {
          signal,
          cache: "no-store",
        });
        const body = (await res.json()) as Payload & { error?: string };
        if (!res.ok) {
          setFailure(body.error ?? "unknown");
          setPayload(null);
        } else {
          setPayload(body);
        }
      } catch (error) {
        if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
        setFailure(error instanceof Error ? error.message : String(error));
        setPayload(null);
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    }

    void load(controller.signal);
    return () => controller.abort();
  }, [submitted, reload]);

  const endpoint = payload?.endpoint ?? OFFICIAL_HF_ENDPOINT;
  const items = payload?.items ?? [];
  const showMore = hasMoreResults(items.length, HF_DISCOVER_LIMIT);

  return (
    <section className="px-7 pb-10">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">
          {submitted === "" ? t("title") : t("searchTitle", { query: submitted })}
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
            onClick={() => setReload((n) => n + 1)}
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
          {t("staleHint", { reason: payload.error })}
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
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setReload((n) => n + 1)}
              >
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
            <p className="text-sm font-medium">{t("emptyTitle")}</p>
            <p className="max-w-md text-sm text-muted-foreground">{t("emptyHint")}</p>
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
                <a href={hfListUrl(submitted, endpoint)} target="_blank" rel="noopener noreferrer" />
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
