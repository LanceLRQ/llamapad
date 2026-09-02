"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";

import type { RepoWeightItem } from "@/lib/repo-weights";
import { fitCount } from "@/lib/fit-row";
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

/** chip 间距、以及 chip 区与「更多」按钮之间的间距——对应 JSX 里两处 gap-2
 *  （Tailwind 1 单位 = 4px），量出来的可用宽度要照这个数扣。两处目前刚好
 *  同值才能共用一个常量，改样式时如果两处间距分叉，这里要拆成两个常量 */
const CHIP_GAP_PX = 8;

/**
 * README 视图「模型权重」卡（任务 2 引入，任务 3 改自适应宽度）：正文上方
 * 常驻一张卡，一行尽量铺满量化档 chip，放不下的用 `fitCount` 量出来的结果
 * 隐藏，「更多」按钮上的数字标注实际隐藏了多少个。点某一项直接切到文件视图
 * 并（若可选中）带着勾选跳过去；「更多」始终在位，兜底去文件视图看全量。
 * 右上角挂着「下次进入不再显示 README」复选框——原先在正文最底下，这里是搬家。
 *
 * loading / total === 0 两种情况这张卡也要整个渲染（只是内容区换成一行
 * 提示文案），否则复选框会跟着消失、用户设置不到这个偏好。
 */
export function RepoWeightsCard({
  items,
  total,
  loading,
  skipLanding,
  onToggleSkip,
  onPick,
  onMore,
}: {
  /** 全部 model 档，不再是截断后的子集——展示几个由本组件量宽度决定 */
  items: RepoWeightItem[];
  total: number;
  loading: boolean;
  /** 「下次进入不再显示 README」的当前值；持久化由调用方负责，本组件只管展示与回调 */
  skipLanding: boolean;
  onToggleSkip: (next: boolean) => void;
  onPick: (index: number) => void;
  onMore: () => void;
}) {
  const t = useTranslations("pages.repos");

  const rowRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const chipRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // 每个 chip 的实测宽度缓存，只在「全部可见」的那一帧写入（见下方
  // isFreshBatch）；窗口缩放触发的重测直接复用这份缓存，不会去量此刻已经
  // 被 hidden（display:none）的 chip——那样量出来的宽度全是 0，会把
  // fitCount 喂错数据，详见下面 useLayoutEffect 里 measure 的注释。只在
  // 效果里读写，不参与渲染判定，用 ref 即可
  const chipWidthsRef = useRef<number[]>([]);

  const [visibleCount, setVisibleCount] = useState(items.length);
  // 记录上一次成功测量对应的 items 引用，用来判断这一批数据是否还没量过。
  // 这份记录要参与渲染判定（下面 isFreshBatch），必须是 state 而不是
  // ref——渲染期间读 ref.current 是 react-hooks/refs 明确禁止的
  const [measuredItems, setMeasuredItems] = useState<RepoWeightItem[] | null>(null);

  // items 换了一批（切仓库、父组件重新拉取 rows）时，量宽度之前的这一帧要
  // 先全部可见——用上一批算出的 visibleCount 去隐藏全新的 chip，会导致它们
  // 以 0 宽度被喂进 fitCount，把这一批的测量结果彻底搞错。全部可见是安全的
  // 起始状态：量不准最多是这一帧多显示几个，外层 overflow-hidden 兜底不会露馅
  const isFreshBatch = measuredItems !== items;
  const visibleUpTo = isFreshBatch ? items.length : visibleCount;

  // 量宽度、决定 visibleCount 的唯一入口——特意不在 effect 顶层直接调用，
  // 全部塞进 ResizeObserver 的回调里（哪怕是首次测量）：react-hooks/set-state-in-effect
  // 不允许 effect 顶层同步 setState，ResizeObserver.observe() 本身在下一次浏览器
  // 绘制前就会异步触发一次回调（报告初始尺寸），借这一拍做首次测量正好绕开限制，
  // 也仍然赶在绘制前完成，不会闪烁
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (row === null || loading || total === 0) return;

    function measure(): void {
      const moreButton = moreButtonRef.current;
      if (row === null || moreButton === null) return;

      // 同一批 items 的重测（窗口缩放触发）直接复用缓存宽度——这时候可能有
      // chip 正被 hidden（display:none 量出来是 0），不能重新去量 DOM；
      // 新一批 items 的这一次，全部 chip 都还没被 hidden（见上面 visibleUpTo
      // 的推导），量出来的 offsetWidth 才是真的，量完顺手缓存
      const widths =
        measuredItems === items
          ? chipWidthsRef.current
          : chipRefs.current.slice(0, items.length).map((el) => el?.offsetWidth ?? 0);
      if (measuredItems !== items) {
        chipWidthsRef.current = widths;
        setMeasuredItems(items);
      }

      const available = row.clientWidth - moreButton.offsetWidth - CHIP_GAP_PX;
      setVisibleCount(fitCount(widths, CHIP_GAP_PX, available));
    }

    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [items, loading, total, measuredItems]);

  const hiddenCount = Math.max(0, total - visibleUpTo);

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
            内——ml-auto 也不需要了，chip 区的 flex-1 已经把按钮推到行尾。
            外层这一行同时是宽度测量的基准（rowRef）：量整行宽度再扣掉按钮
            宽与 gap 才是 chip 可用宽度，量内层（已经被 flex 挤过一次的）
            div 会重复扣一次，见 fit-row.ts 调用处 */}
        <div ref={rowRef} className="flex items-center gap-2">
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
              items.map((item, i) => (
                <button
                  key={item.index}
                  ref={(el) => {
                    chipRefs.current[i] = el;
                  }}
                  type="button"
                  hidden={i >= visibleUpTo}
                  onClick={() => onPick(item.index)}
                  className="flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs transition-colors hover:border-foreground/20"
                >
                  <span className={cn("size-1.5 shrink-0 rounded-full", STATE_DOT_CLASS[item.state])} />
                  <span className="font-mono font-medium">{item.quant ?? t("unknownQuant")}</span>
                  <span className="text-muted-foreground">{formatSize(item.totalSize)}</span>
                </button>
              ))}
          </div>

          {/* 「更多」始终在位——放得下时它就是去文件视图的常规入口；放不下
              的档超出时用一个纯数字小标标出还有多少没展示，不吃新的文案键 */}
          <Button ref={moreButtonRef} size="sm" variant="outline" className="shrink-0 gap-1" onClick={onMore}>
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
