"use client";

import { Download, ExternalLink, Heart, Lock, TrendingUp } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatCount } from "@/lib/format";
import { hfRepoUrl, type HfModelSummary } from "@/lib/hf-models";

/**
 * 发现区的单张模型卡（2026-09-21 HF 模型发现设计 §9）。
 *
 * `ownedProfileId` 非空表示这个 repo 本地已经建过仓库档案：此时主按钮从「下载」
 * 换成「查看档案」直达详情页。热门榜里撞上自己已有的仓库是常事，不标会让人重复建档。
 */
export function DiscoverCard({
  model,
  endpoint,
  ownedProfileId,
  onDownload,
}: {
  model: HfModelSummary;
  endpoint: string;
  ownedProfileId: number | null;
  onDownload: (repo: string) => void;
}) {
  const t = useTranslations("pages.modelsHome.discover");
  const format = useFormatter();

  return (
    <Card className="h-full">
      <CardContent className="flex h-full flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <span className="min-w-0 truncate font-mono text-sm font-semibold" title={model.repo}>
            {model.name}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            {model.gated && (
              <Badge
                variant="outline"
                className="gap-1 border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
              >
                <Lock className="size-3!" />
                {t("gatedBadge")}
              </Badge>
            )}
            {ownedProfileId !== null && (
              <Badge variant="outline" className="border-primary/35 bg-primary/10 text-primary">
                {t("ownedBadge")}
              </Badge>
            )}
          </div>
        </div>

        <p className="truncate text-xs text-muted-foreground">{model.owner}</p>

        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {model.trending !== null && (
            <span className="inline-flex items-center gap-1">
              <TrendingUp className="size-3" />
              {formatCount(model.trending)}
            </span>
          )}
          <span className="inline-flex items-center gap-1">
            <Heart className="size-3" />
            {formatCount(model.likes)}
          </span>
          <span className="inline-flex items-center gap-1">
            <Download className="size-3" />
            {formatCount(model.downloads)}
          </span>
        </p>

        <p className="truncate text-xs text-muted-foreground">
          {model.task ?? "—"}
          {/* updatedAt 为 0 表示上游没给出可解析的时间（见 lib/hf-models.ts 的
              toModelSummary），此时整段不渲染，不显示一个假的 1970 年 */}
          {model.updatedAt > 0 &&
            ` · ${t("updatedAt", { ago: format.relativeTime(model.updatedAt) })}`}
        </p>

        <div className="mt-auto flex items-center gap-2 pt-1">
          {ownedProfileId === null ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => onDownload(model.repo)}
            >
              <Download className="size-3.5" />
              {t("download")}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              nativeButton={false}
              render={<Link href={`/models/repos/${ownedProfileId}`} />}
            >
              {t("viewProfile")}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            title={t("openOnHf")}
            aria-label={t("openOnHf")}
            nativeButton={false}
            render={
              <a href={hfRepoUrl(model.repo, endpoint)} target="_blank" rel="noopener noreferrer" />
            }
          >
            <ExternalLink className="size-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
