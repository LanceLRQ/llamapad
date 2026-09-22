"use client";

import { Download, ExternalLink, Heart, Lock, TrendingUp } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
              // 徽标自己当 tooltip 触发器（照 files/unclaimed-table.tsx 的 Badge 触发器
              // 先例），不另加一枚 ⓘ 图标——卡片信息已经很密，多一个图标是噪音。
              // Badge 渲染成 span 不可聚焦，所以补 tabIndex 让键盘也能唤出提示，
              // 与 repos/[id]/repo-detail-view.tsx 那个 span 触发器同款做法
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Badge
                      variant="outline"
                      tabIndex={0}
                      className="gap-1 cursor-default border-amber-500/30 bg-amber-500/10 text-amber-600 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring dark:text-amber-400"
                    />
                  }
                >
                  <Lock className="size-3!" />
                  {t("gatedBadge")}
                </TooltipTrigger>
                <TooltipContent>{t("gatedHint")}</TooltipContent>
              </Tooltip>
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
          {/* `||` 而不是 `??`：task 缺省是 null，但 HF 也给过空字符串，
              `??` 只挡 null/undefined，空串会落成一段看不出所以然的空白 */}
          {model.task || "—"}
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
