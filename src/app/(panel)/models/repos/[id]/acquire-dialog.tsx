"use client";

import { CheckCircle2, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { AcquireAction } from "@/lib/acquire-match";
import {
  canSubmit,
  groupKey,
  hasExecutingRow,
  isRowEditable,
  rowLabel,
  type AcquireRow,
} from "@/lib/acquire-plan";

/**
 * 获取确认弹层（设计 §9.1）
 *
 * 用户点「下载选中项」后先进这里，逐行确认用什么手段拿到文件——本地已有的
 * 可以移动 / 链接 / 复制，本地没有的只能下载。确认后才真正入队。
 *
 * 行状态与进度全部由 lib/acquire-plan.ts 计算，本组件只管渲染与事件：
 * 这是项目的既定分工（vitest 无 jsdom，判定不下沉就没有测试）。
 */
export function AcquireDialog({
  open,
  rows,
  onOpenChange,
  onChangeAction,
  onSubmit,
  onRunInBackground,
}: {
  open: boolean;
  rows: AcquireRow[];
  onOpenChange: (open: boolean) => void;
  /** 第一个参数是组身份 `groupKey(row)`，不是文件名——动作按组选（设计 §4.4） */
  onChangeAction: (key: string, action: AcquireAction) => void;
  onSubmit: () => void;
  /** 执行中的逃生口：关闭弹层但不中断任务（X / Esc 被执行中守卫拦住，见下方按钮） */
  onRunInBackground: () => void;
}) {
  const t = useTranslations("pages.repos");

  // "move" -> acquireActionMove，与远端文件名一样按约定拼键，避免四份重复的 t() 调用。
  // move-with-refs 单独判：拼接式键名对带连字符的动作会算出
  // "acquireActionMove-with-refs" 这种不存在的键，这两个键本身也不跟 acquireAction*
  // 前缀（任务 14 步骤 3 定的文案键），必须单列
  function actionLabel(a: AcquireAction): string {
    if (a === "move-with-refs") return t("actionMoveWithRefs");
    return t(`acquireAction${a[0]!.toUpperCase()}${a.slice(1)}`);
  }

  function actionHint(a: AcquireAction): string {
    if (a === "move-with-refs") return t("actionMoveWithRefsHint");
    return t(`acquireHint${a[0]!.toUpperCase()}${a.slice(1)}`);
  }

  // 组级 restriction 只带原因码，具体是哪个档案（in-repo）要从**产生这条限制的
  // 那个文件**身上取：mergeGroupMatch 取的是组内第一个 restriction 非 none 的
  // 文件，按「第一个有候选的文件」去找很可能落到另一个文件（它的 inRepoDir 是
  // null），{repo} 就填成了空串
  function restrictionText(row: AcquireRow): string {
    if (row.restriction === "in-repo") {
      const origin = row.files.find((f) => f.restriction === row.restriction);
      return t("acquireRestrictionInRepo", { repo: origin?.candidate?.inRepoDir ?? "" });
    }
    if (row.restriction === "outside-root") return t("acquireRestrictionOutside");
    if (row.restriction === "version-drift") return t("restrictionVersionDrift");
    return t("acquireRestrictionNoOid");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("acquireTitle")}</DialogTitle>
          <DialogDescription>{t("acquireDesc")}</DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-2 overflow-y-auto">
          {rows.map((row, index) => {
            const key = groupKey(row);
            // 组内没有本地副本的文件数：组级动作只施加到有副本的那些，其余照常下载
            const missing = row.files.filter((f) => f.candidate === null).length;
            const source = row.files.find((f) => f.candidate !== null)?.candidate ?? null;
            // 到达/失败后不许再改动作——与 canSubmit 同一判据，调 isRowEditable 而不是原地复刻一份
            const editable = isRowEditable(row);
            const percent = row.progress !== null ? Math.floor(row.progress * 100) : null;
            // Select 触发器不是原生 <select>，用 aria-labelledby 挂到本行的文件名文本上，
            // 而不是新造一条纯文案——一份 groupKey 里可能含 "/"，不拿它当 DOM id
            const labelId = `acquire-row-${index}`;

            return (
              <div key={key} className="rounded-md border p-3">
                <div className="flex items-center justify-between gap-3">
                  {/* 主身份是文件名（含目录）而不是量化标签：同一个 (quant, kind)
                      下可以有多组——真机 unsloth 仓库里 `Qwen3.8-27B-Q4_0.gguf`
                      与 `MTP/mtp-Qwen3.8-27B-Q4_0.gguf` 就并存，两行都只写
                      "Q4_0" 时用户分不出自己选的是哪个。量化/mmproj/分片数降为
                      文件名后面的次要说明，与档案页卡片同一套主次关系 */}
                  <span id={labelId} className="min-w-0 text-xs break-all">
                    <span className="font-mono font-medium">{rowLabel(row)}</span>
                    <span className="ml-1.5 text-muted-foreground">
                      {row.quant ?? t("unknownQuant")}
                      {row.kind === "mmproj" && " · mmproj"}
                      {row.files.length > 1 && ` · ${t("shardBadge", { count: row.files.length })}`}
                    </span>
                  </span>
                  <div className="flex shrink-0 items-center gap-2">
                    {row.manual && (
                      <Badge
                        variant="outline"
                        className="h-4.5 px-1.5 font-sans text-[10px] leading-none text-muted-foreground"
                      >
                        {t("manualBadge")}
                      </Badge>
                    )}
                    {row.actions.length > 1 ? (
                      <Select
                        value={row.action}
                        onValueChange={(v) => onChangeAction(key, v as AcquireAction)}
                      >
                        <SelectTrigger
                          size="sm"
                          className="w-28 shrink-0"
                          disabled={!editable}
                          aria-labelledby={labelId}
                        >
                          <SelectValue>{actionLabel(row.action)}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {row.actions.map((a) => (
                            <SelectItem key={a} value={a}>
                              {actionLabel(a)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <span className="text-xs text-muted-foreground">{t("acquireActionDownload")}</span>
                    )}
                  </div>
                </div>

                {source !== null && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("acquireSourceAt", { path: source.rel ?? source.absPath })}
                  </p>
                )}
                {row.actions.length > 1 && row.action !== "download" && (
                  <p className="mt-1 text-xs text-muted-foreground">{actionHint(row.action)}</p>
                )}
                {/* 混合组必须说清楚：用户选了「移动」却看见一条下载进度，
                    不解释的话会以为出错了 */}
                {missing > 0 && row.action !== "download" && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("acquireMixedDownload", { count: missing })}
                  </p>
                )}
                {row.restriction !== "none" && (
                  <p className="mt-1 text-xs text-muted-foreground">{restrictionText(row)}</p>
                )}

                {row.phase === "executing" && (
                  <div className="mt-2 flex flex-col gap-1">
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      {percent === null && <Loader2 className="size-3 animate-spin" />}
                      {actionLabel(row.action)} · {t("acquirePhaseExecuting")}
                      {percent !== null && ` ${percent}%`}
                    </span>
                    {percent !== null && (
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary transition-[width] duration-500"
                          style={{ width: `${percent}%` }}
                        />
                      </div>
                    )}
                  </div>
                )}
                {row.phase === "done" && (
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-accent-green">
                    <CheckCircle2 className="size-3.5" />
                    {actionLabel(row.action)} · {t("acquirePhaseDone")}
                  </p>
                )}
                {row.phase === "failed" && (
                  <div className="mt-2 flex items-center gap-2">
                    <span className="text-xs text-destructive">
                      {row.error ?? t("acquireErrorMismatch")}
                    </span>
                    {row.canFallbackToDownload && (
                      <Button size="sm" variant="outline" onClick={() => onChangeAction(key, "download")}>
                        {t("acquireFallbackDownload")}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <DialogFooter>
          {/* 执行中不许直接关闭（半途 kill 掉正在 move/copy 的任务会留下半成品），
              但不能因此没有出路：这个按钮关掉弹层、任务继续在队列里跑，下载页可见 */}
          {hasExecutingRow(rows) && (
            <Button
              variant="outline"
              onClick={onRunInBackground}
              title={t("acquireRunInBackgroundHint")}
            >
              {t("acquireRunInBackground")}
            </Button>
          )}
          <Button onClick={onSubmit} disabled={!canSubmit(rows)}>
            {t("acquireSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
