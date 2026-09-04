"use client";

import { useState } from "react";
import { FolderOpen, Layers } from "lucide-react";
import { useTranslations } from "next-intl";

import { groupByDir, type PickerGroup, type PickerItem } from "@/lib/model-file-picker";
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
 * 三条刻意的设计：
 * - **不硬过滤**：mmproj 的识别靠文件名前缀，而那是社区约定不是规范。
 *   一旦按前缀过滤，命名不规范的投影文件就会从选择器里彻底消失，用户连
 *   手动救济的机会都没有。这里只做「排序靠后 + 分隔线 + 弱化」，引导不阻断。
 * - **输入框保持可编辑**：弹层是辅助不是替代。glob 形态、尚未落盘的路径
 *   这类情况仍然需要手输。
 * - **按目录分组（规格 §4.2）**：models 目录按一级目录平铺、跨目录引用
 *   是既有语义，`main/qwen-Q4_K_M.gguf` 与 `test/qwen-Q4_K_M.gguf` 在这里
 *   是字面相同的候选项，不分组用户只能靠猜。分隔线上下两个区域各自按
 *   dir 分组、mono 小标题 + 缩进的行，与文件页（files-table.tsx）
 *   同款语义的更轻量版本。
 */
export function ModelFilePicker({
  items,
  field,
  onSelect,
  namespace,
  trigger,
  open: openProp,
  onOpenChange: onOpenChangeProp,
  descriptionParams,
}: {
  items: PickerItem[];
  /** 决定标题与哪一类排在前面 */
  field: "gguf" | "mmproj";
  onSelect: (value: string) => void;
  /** 弹层标题/说明的文案命名空间；缺省 common.filePicker（既有行为）。有值时
   *  标题/说明改读该命名空间下固定的 manualPickerTitle/manualPickerHint 两个
   *  键（任务 16：手动关联弹层） */
  namespace?: string;
  /** 触发器渲染；缺省是既有那个「浏览」按钮 */
  trigger?: React.ReactElement;
  /** 受控 open（复核修复 F-1/F-7）：手动关联弹层由外层"先扫描再开"驱动，不经
   *  DialogTrigger 自身的点击打开；缺省沿用内部 useState 自管理，既有调用方
   *  零改动。受控且不传 trigger 时不渲染任何触发器（纯由外部状态驱动） */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** 说明文案插值参数（复核修复 F-6）：namespace 有值时 manualPickerHint 带
   *  {remote} 占位符，这里传入实际值 */
  descriptionParams?: Record<string, string | number>;
}) {
  const t = useTranslations("common.filePicker");
  const tCustom = useTranslations(namespace ?? "common.filePicker");
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : internalOpen;
  const setOpen = isControlled ? (onOpenChangeProp ?? (() => {})) : setInternalOpen;

  // 选投影文件时两类对调：当前字段"想要"的那一类排在前面，另一类在分隔线以下
  const preferred = field === "mmproj" ? "mmproj" : "model";
  const primaryGroups = groupByDir(items.filter((i) => i.kind === preferred));
  const secondaryGroups = groupByDir(items.filter((i) => i.kind !== preferred));

  function pick(value: string) {
    onSelect(value);
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {(!isControlled || trigger !== undefined) && (
        <DialogTrigger
          render={
            trigger ?? <Button type="button" variant="outline" size="sm" className="h-8 shrink-0 px-2" />
          }
        >
          <FolderOpen className="size-3.5" />
          {t("browse")}
        </DialogTrigger>
      )}
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {namespace !== undefined
              ? tCustom("manualPickerTitle")
              : t(field === "mmproj" ? "titleMmproj" : "titleGguf")}
          </DialogTitle>
          <DialogDescription>
            {namespace !== undefined ? tCustom("manualPickerHint", descriptionParams) : t("description")}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[55vh] overflow-y-auto">
          {items.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {namespace !== undefined ? tCustom("manualPickerEmpty") : t("empty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {primaryGroups.map((group) => (
                <PickerDirGroup key={group.dir} group={group} onPick={pick} />
              ))}
              {secondaryGroups.length > 0 && (
                <li className="flex items-center gap-2 px-1 pt-3 pb-1.5">
                  <span className="h-px flex-1 bg-border" />
                  <span className="text-[11px] text-muted-foreground">
                    {t(preferred === "model" ? "hintMmproj" : "hintModel")}
                  </span>
                  <span className="h-px flex-1 bg-border" />
                </li>
              )}
              {secondaryGroups.map((group) => (
                <PickerDirGroup key={group.dir} group={group} onPick={pick} dimmed />
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

/**
 * 一个目录分组：mono 小标题 + 缩进的行（files-table.tsx 整张 Card 的更轻
 * 量版本——弹层是浮层不是独立页面，不值得为每个目录起一张卡片）。
 * dimmed 透传给标题与每一行，让分隔线以下的整个区域一并弱化。
 */
function PickerDirGroup({
  group,
  onPick,
  dimmed,
}: {
  group: PickerGroup;
  onPick: (value: string) => void;
  dimmed?: boolean;
}) {
  const t = useTranslations("common.filePicker");
  // dir === "" 是根下文件（阶段 3a 起 dir 取完整目录路径，根下文件没有
  // 目录段可拼）：渲染成 "" + "/" 会得到一个孤零零的斜杠，看不出这一组
  // 是什么，改成一个明确的"models 根"标题。title 属性给深层路径
  // （如 "qwen3.6/70b"）一个 hover 全文——truncate 只保证不撑破布局，
  // 不保证用户能看全被截断的部分。
  const label = group.dir === "" ? t("rootGroupLabel") : `${group.dir}/`;
  return (
    <>
      <li
        title={group.dir === "" ? undefined : group.dir}
        className={cn(
          "truncate px-2 pt-2 pb-0.5 font-mono text-[11px] font-semibold text-muted-foreground",
          dimmed && "opacity-60",
        )}
      >
        {label}
      </li>
      {group.items.map((item) => (
        <PickerRow key={item.value} item={item} onPick={onPick} dimmed={dimmed} />
      ))}
    </>
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
          "flex w-full items-center gap-2.5 rounded-md py-2 pr-2 pl-4 text-left transition-colors hover:bg-accent",
          dimmed && "opacity-60",
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-sm">{item.label}</span>
          <span className="flex flex-wrap items-center gap-1.5 pt-0.5 text-[11px] text-muted-foreground">
            <span>{item.quant ?? t("quantUnknown")}</span>
            <span>·</span>
            <span>{formatSize(item.totalSize)}</span>
            {item.refs > 0 ? (
              <>
                <span>·</span>
                <span>{t("refs", { count: item.refs })}</span>
              </>
            ) : (
              // refs === 0 不是"没信息"而是"还没人用"——这正是用户来选文件时
              // 最想先看到的那批，之前它与已被占用的文件长得一模一样
              <Badge variant="outline" className="shrink-0 px-1.5 text-[10px] text-muted-foreground">
                {t("unused")}
              </Badge>
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
