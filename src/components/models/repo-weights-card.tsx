"use client";

import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";

import type { RepoWeightItem } from "@/lib/repo-weights";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { formatSize } from "@/lib/format";
import { cn } from "@/lib/utils";

/** 状态点配色与 repo-detail-view.tsx 的 StateCell 同一口径（改一处要同步
 *  改两处）：这里只取颜色不取文案——权重卡一行寸土寸金，放不下状态文字，
 *  也是不复用 StateCell 本身的原因，那是给宽敞的文件视图卡片用的 */
const STATE_DOT_CLASS: Record<RepoWeightItem["state"], string> = {
  present: "bg-accent-green",
  downloading: "bg-primary animate-pulse",
  partial: "bg-muted-foreground",
  stray: "bg-amber-500",
  absent: "bg-muted-subtle",
};

/**
 * README 视图「模型权重」卡（任务 2）：正文上方常驻一张卡，横排展示最多
 * WEIGHTS_PREVIEW_LIMIT 个量化档，点某一项直接切到文件视图并（若可选中）
 * 带着勾选跳过去；「更多」始终在位，兜底去文件视图看全量。右上角挂着
 * 「下次进入不再显示 README」复选框——原先在正文最底下，这里是搬家。
 *
 * loading / total === 0 两种情况这张卡也要整个渲染（只是内容区换成一行
 * 提示文案），否则复选框会跟着消失、用户设置不到这个偏好。
 */
export function RepoWeightsCard({
  items,
  hiddenCount,
  total,
  loading,
  skipLanding,
  onToggleSkip,
  onPick,
  onMore,
}: {
  items: RepoWeightItem[];
  hiddenCount: number;
  total: number;
  loading: boolean;
  /** 「下次进入不再显示 README」的当前值；持久化由调用方负责，本组件只管展示与回调 */
  skipLanding: boolean;
  onToggleSkip: (next: boolean) => void;
  onPick: (index: number) => void;
  onMore: () => void;
}) {
  const t = useTranslations("pages.repos");

  return (
    <Card>
      <CardContent className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-baseline gap-2">
            <h2 className="text-sm font-semibold">{t("weightsTitle")}</h2>
            <span className="text-xs text-muted-foreground">{t("weightsCount", { count: total })}</span>
          </div>
          <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox checked={skipLanding} onCheckedChange={(v) => onToggleSkip(v === true)} />
            {t("readmeSkipLanding")}
          </label>
        </div>

        {/* 必须拆两层：chip 区与「更多」按钮不能待在同一个 overflow-hidden
            容器里。原先只有一层时，全部子项（含按钮）都是 shrink-0，行宽
            不够时没有谁会缩、也没有多余空间给 ml-auto 吃——超出的部分直接
            被 overflow-hidden 从右边裁掉，而按钮恰好是最后一个子项，第一个
            被裁掉的就是它：按钮还在 DOM 里，但落在可视区外，点不到。
            现在 overflow-hidden 只扣在内层 chip 容器上，外层不裁剪；内层
            靠 min-w-0 + flex-1 才能真正被压缩（flex 子项默认 min-width:auto，
            没有 min-w-0 会被内容撑开、flex-1 也无法把它缩到容器宽度以内）；
            按钮是外层的兄弟节点、shrink-0，永远保持完整宽度、永远在可视区
            内——ml-auto 也不需要了，chip 区的 flex-1 已经把按钮推到行尾 */}
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
            {loading && (
              <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                {t("weightsLoading")}
              </span>
            )}
            {!loading && total === 0 && (
              <span className="shrink-0 text-xs text-muted-foreground">{t("weightsEmpty")}</span>
            )}
            {!loading &&
              items.map((item) => (
                <button
                  key={item.index}
                  type="button"
                  onClick={() => onPick(item.index)}
                  className="flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs transition-colors hover:border-foreground/20"
                >
                  <span className={cn("size-1.5 shrink-0 rounded-full", STATE_DOT_CLASS[item.state])} />
                  <span className="font-mono font-medium">{item.quant ?? t("unknownQuant")}</span>
                  <span className="text-muted-foreground">{formatSize(item.totalSize)}</span>
                </button>
              ))}
          </div>

          {/* 「更多」始终在位——不足 6 个时它就是去文件视图的常规入口；
              超出时用一个纯数字小标标出还有多少没展示，不吃新的文案键 */}
          <Button size="sm" variant="outline" className="shrink-0 gap-1" onClick={onMore}>
            {t("weightsMore")}
            {hiddenCount > 0 && (
              <span className="rounded-full bg-muted px-1.5 text-[10px] font-normal text-muted-foreground">
                {hiddenCount}
              </span>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
