"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { FileText, Loader2, Lock, RefreshCw, TriangleAlert } from "lucide-react";

import { Markdown } from "@/components/markdown";
import { toast } from "@/components/toast-store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { apiFetch } from "@/lib/api";
import { resolveReadmeUrl } from "@/lib/readme-links";
import { REPO_README_LANDING_KEY } from "@/lib/repo-readme-tabs";

/** 与 GET /api/v1/repos/:id/readme 响应逐字段对齐（该路由 JSDoc 写了完整形状） */
export interface ReadmeResponse {
  repo: string;
  content: string | null;
  badges: { key: string; value: string }[];
  endpoint: string;
  truncated: boolean;
  fetchedAt: number;
  profiles: unknown[];
  profilesEngine: string | null;
  error: { kind: "notFound" | "unauthorized" | "network"; message: string } | null;
}

/** 徽章 key → i18n 键；未知 key 不渲染（后端加字段不会让前端崩） */
const BADGE_LABEL: Record<string, string> = {
  license: "badgeLicense",
  base_model: "badgeBaseModel",
  pipeline_tag: "badgePipelineTag",
  tags: "badgeTags",
};

/**
 * 档案详情页的 README 视图（HF README 视图）
 *
 * 挂载后自己 fetch（缓存为空时服务端会同步拉一次），期间显示加载态。
 * **失败不白屏**：有旧缓存就照常渲染正文，只在顶部挂一条提示——与同目录
 * repo-detail-view.tsx 的降级原则一致。
 */
export function ReadmeView({
  repoId,
  landingReadme,
  onGoFiles,
}: {
  repoId: number;
  /** SSR 传入的当前设置值，用作复选框初值 */
  landingReadme: boolean;
  /** 勾了「下次直接进文件列表」后，用户点空态里的「去文件列表」时调用 */
  onGoFiles: () => void;
}) {
  const t = useTranslations("pages.repos");
  const [data, setData] = useState<ReadmeResponse | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "error">("loading");
  const [refreshing, setRefreshing] = useState(false);
  const [skipLanding, setSkipLanding] = useState(!landingReadme);

  // 与 repo-detail-view.tsx 同一形状：刷新与首载共用一条请求路径，
  // 乱序回来的旧响应不许覆盖新数据
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (refresh: boolean) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      try {
        const res = await apiFetch(
          `/api/v1/repos/${repoId}/readme${refresh ? "?refresh=1" : ""}`,
          { signal: controller.signal, cache: "no-store" },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setData((await res.json()) as ReadmeResponse);
        setLoadState("loaded");
      } catch (error) {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
          return;
        }
        setLoadState("error");
      }
    },
    [repoId],
  );

  useEffect(() => {
    const tick = () => void load(false);
    tick();
    return () => controllerRef.current?.abort();
  }, [load]);

  async function onRefresh(): Promise<void> {
    if (refreshing) return;
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  }

  function onToggleSkip(next: boolean): void {
    setSkipLanding(next);
    // fire-and-forget：这是个偏好位，写失败不该打断阅读（与 onboarding_playground_seen 同款）
    void apiFetch(`/api/v1/settings/${REPO_README_LANDING_KEY}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: next ? "0" : "1" }),
    }).catch(() => toast.error(t("errorRequest")));
  }

  if (loadState === "loading") {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {t("readmeLoading")}
      </div>
    );
  }

  if (loadState === "error" || data === null) {
    return (
      <Card>
        <CardContent className="flex flex-col items-start gap-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <TriangleAlert className="size-4 text-destructive" />
            {t("readmeNetworkTitle")}
          </div>
          <p className="text-sm text-muted-foreground">{t("readmeNetworkDescription")}</p>
          <Button size="sm" variant="outline" onClick={() => void load(true)}>
            <RefreshCw className="size-3.5" />
            {t("detailRetry")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const hasContent = data.content !== null && data.content.trim() !== "";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {data.badges.map((badge) =>
          BADGE_LABEL[badge.key] === undefined ? null : (
            <Badge key={badge.key} variant="outline" className="font-normal">
              <span className="text-muted-foreground">{t(BADGE_LABEL[badge.key])}</span>
              <span className="ml-1.5">{badge.value}</span>
            </Badge>
          ),
        )}
        <span className="ml-auto flex items-center gap-2">
          {data.fetchedAt > 0 && (
            <span className="text-[11px] text-muted-foreground">
              {t("readmeUpdatedAt", { time: new Date(data.fetchedAt).toLocaleString() })}
            </span>
          )}
          <Button size="sm" variant="outline" disabled={refreshing} onClick={() => void onRefresh()}>
            {refreshing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            {t("readmeRefresh")}
          </Button>
        </span>
      </div>

      {data.error !== null && data.error.kind === "network" && hasContent && (
        <p className="text-xs text-destructive">{t("readmeRefreshFailed")}</p>
      )}
      {data.truncated && <p className="text-xs text-muted-foreground">{t("readmeTruncated")}</p>}

      {data.error?.kind === "unauthorized" && !hasContent ? (
        <Card>
          <CardContent className="flex flex-col items-start gap-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Lock className="size-4" />
              {t("readmeUnauthorizedTitle")}
            </div>
            <p className="text-sm text-muted-foreground">{t("readmeUnauthorizedDescription")}</p>
            {/* 本仓 Button 是 Base UI 形态，没有 asChild，跳转用 render={<Link/>}
                （与 repo-detail-view.tsx 的「创建配置」同一写法）。深链给
                tab=library——HF Token 卡在设置页「资料库」组，非法 tab 会被
                resolveSettingsTab 兜底到 runtime，等于没带用户去目的地 */}
            <Button
              size="sm"
              variant="outline"
              nativeButton={false}
              render={<Link href="/settings?tab=library" />}
            >
              {t("readmeUnauthorizedAction")}
            </Button>
          </CardContent>
        </Card>
      ) : hasContent ? (
        <Markdown
          text={data.content ?? ""}
          className="max-w-none"
          urlTransform={(url, key) =>
            resolveReadmeUrl(url, {
              repo: data.repo,
              endpoint: data.endpoint,
              kind: key === "src" ? "image" : "link",
            }) ?? ""
          }
        />
      ) : (
        <Card>
          <CardContent className="flex flex-col items-start gap-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <FileText className="size-4" />
              {t("readmeEmptyTitle")}
            </div>
            {/* 措辞刻意不像「解析失败」：实测 12 个样本里有 6 个确实没写，
                这是常态不是故障，说成故障会让用户反复刷新 */}
            <p className="text-sm text-muted-foreground">{t("readmeEmptyDescription")}</p>
            <Button size="sm" variant="outline" onClick={onGoFiles}>
              {t("views.files.name")}
            </Button>
          </CardContent>
        </Card>
      )}

      <label className="flex items-center gap-2 pt-2 text-xs text-muted-foreground">
        <Checkbox checked={skipLanding} onCheckedChange={(v) => onToggleSkip(v === true)} />
        {t("readmeSkipLanding")}
      </label>
    </div>
  );
}
