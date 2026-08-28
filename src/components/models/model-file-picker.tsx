"use client";

import { useState } from "react";
import { FolderOpen, Layers } from "lucide-react";
import { useTranslations } from "next-intl";

import type { PickerItem } from "@/lib/model-file-picker";
import { formatSize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * 模型文件选择弹层（规格 §4）：数据来自 server component 直接下发的文件树，
 * 不发请求、无 loading 态。
 *
 * 两条刻意的设计：
 * - **不硬过滤**：mmproj 的识别靠文件名前缀，而那是社区约定不是规范。
 *   一旦按前缀过滤，命名不规范的投影文件就会从选择器里彻底消失，用户连
 *   手动救济的机会都没有。这里只做「排序靠后 + 分隔线 + 弱化」，引导不阻断。
 * - **输入框保持可编辑**：弹层是辅助不是替代。glob 形态、尚未落盘的路径
 *   这类情况仍然需要手输。
 */
export function ModelFilePicker({
  items,
  field,
  onSelect,
}: {
  items: PickerItem[];
  /** 决定标题与哪一类排在前面 */
  field: "gguf" | "mmproj";
  onSelect: (value: string) => void;
}) {
  const t = useTranslations("common.filePicker");
  const [open, setOpen] = useState(false);

  // 选投影文件时两类对调：当前字段"想要"的那一类排在前面，另一类在分隔线以下
  const preferred = field === "mmproj" ? "mmproj" : "model";
  const primary = items.filter((i) => i.kind === preferred);
  const secondary = items.filter((i) => i.kind !== preferred);

  function pick(value: string) {
    onSelect(value);
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<Button type="button" variant="outline" size="sm" className="h-8 shrink-0 px-2" />}
      >
        <FolderOpen className="size-3.5" />
        {t("browse")}
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t(field === "mmproj" ? "titleMmproj" : "titleGguf")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[55vh] overflow-y-auto">
          {items.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {primary.map((item) => (
                <PickerRow key={item.value} item={item} onPick={pick} />
              ))}
              {secondary.length > 0 && (
                <li className="flex items-center gap-2 px-1 pt-3 pb-1.5">
                  <span className="h-px flex-1 bg-border" />
                  <span className="text-[11px] text-muted-foreground">
                    {t(preferred === "model" ? "hintMmproj" : "hintModel")}
                  </span>
                  <span className="h-px flex-1 bg-border" />
                </li>
              )}
              {secondary.map((item) => (
                <PickerRow key={item.value} item={item} onPick={pick} dimmed />
              ))}
            </ul>
          )}
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>{t("cancel")}</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 一行候选：文件名（分片组标识）/ 量化 / 体积 / 引用数；dimmed 为分隔线以下的弱化项 */
function PickerRow({
  item,
  onPick,
  dimmed,
}: {
  item: PickerItem;
  onPick: (value: string) => void;
  dimmed?: boolean;
}) {
  const t = useTranslations("common.filePicker");
  const incomplete = item.shardTotalDeclared !== null && item.shards !== item.shardTotalDeclared;

  return (
    <li>
      <button
        type="button"
        onClick={() => onPick(item.value)}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent",
          dimmed && "opacity-60",
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-sm">{item.label}</span>
          <span className="flex flex-wrap items-center gap-1.5 pt-0.5 text-[11px] text-muted-foreground">
            <span>{item.quant ?? t("quantUnknown")}</span>
            <span>·</span>
            <span>{formatSize(item.totalSize)}</span>
            {item.refs > 0 && (
              <>
                <span>·</span>
                <span>{t("refs", { count: item.refs })}</span>
              </>
            )}
          </span>
        </span>
        {item.shardTotalDeclared !== null && (
          <Badge
            variant="outline"
            className={cn(
              "h-5 shrink-0 gap-1 px-1.5 text-[10px]",
              incomplete && "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
            )}
          >
            <Layers className="size-3" />
            {incomplete
              ? t("shardsIncomplete", { found: item.shards, declared: item.shardTotalDeclared })
              : t("shards", { count: item.shards })}
          </Badge>
        )}
      </button>
    </li>
  );
}
