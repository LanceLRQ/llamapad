"use client";

import type { ReactNode } from "react";
import { Search } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

/**
 * 筛选条（M16 T3）：chip 筛选 + 「显示 N / M」+ 搜索框 + 主操作，四段横排。
 * 选中态由调用方通过 activeChip/onChipChange 管理（不像 SecondaryNav 那样
 * 自己接 URL query）——工具条常出现在页面内某个已经在管理自身筛选状态的表格/
 * 列表旁边，把状态收口再套一层 query 读写反而多绕一手，故这里只做纯展示 + 回调。
 * chip 的计数由调用方算好传入（见 lib/toolbar-counts.ts 的 computeChipCounts，
 * 那条"计数不参与自身筛选"的规则在那边测，这个文件不重复判断）。
 *
 * 右侧「显示 N / M · 搜索 · 主操作」整组必须一起换行，不能让主操作单独落单
 * （`flex-nowrap` 钉住这一组，`ml-auto` 只负责把整组推到最右）；chip 本身
 * `whitespace-nowrap shrink-0`，防止窄屏把词组折断。
 */

interface FilterChip {
  key: string;
  label: string;
  count: number;
}

interface ToolbarProps {
  chips: FilterChip[];
  activeChip: string;
  onChipChange: (key: string) => void;
  /** 右侧「显示 N / M」，不传不渲染 */
  note?: { shown: number; total: number };
  /** 排序控件（目前只有 models-table 传），挂在搜索框之前——筛选 chip → 排序 →
   *  搜索，读起来是一组；不传不渲染，其余调用方渲染结果不受影响 */
  sort?: ReactNode;
  search?: { value: string; onChange: (v: string) => void; placeholder: string };
  /** 右侧主操作，调用方给一个按钮 */
  action?: ReactNode;
}

export function Toolbar({ chips, activeChip, onChipChange, note, sort, search, action }: ToolbarProps) {
  const t = useTranslations("common");

  return (
    <div className="flex flex-wrap items-center gap-2 gap-y-2 border-b border-border/50 px-7 py-[9px]">
      {chips.map((chip) => {
        // 计数为 0 时不是一个"当前没有命中的活选项"，是"这条路根本走不通"——
        // 不能让它看起来能点，点了跳进一个空列表
        const disabled = chip.count === 0;
        const active = chip.key === activeChip;
        return (
          <button
            key={chip.key}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            onClick={() => onChipChange(chip.key)}
            className={cn(
              "inline-flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-card px-2.5 text-[12.5px] text-muted-foreground",
              // 选中态与"计数为 0"是可以叠加的两件事，不是互斥的——当前选中的
              // chip 因为搜索收窄变成 0 命中时，用户仍要看得出"现在筛的是这条"，
              // 弱化只是叠加在选中态之上，不能让选中态整个消失
              active && "border-primary bg-primary/10 font-semibold text-primary",
              disabled && "cursor-default opacity-42",
            )}
          >
            {chip.label}
            <span className="font-mono text-[11.5px] tabular-nums opacity-70">{chip.count}</span>
          </button>
        );
      })}

      <div className="ml-auto flex flex-nowrap items-center gap-2.5">
        {note && (
          <span className="whitespace-nowrap font-mono text-xs text-muted-foreground opacity-80">
            {t("showingCount", { shown: note.shown, total: note.total })}
          </span>
        )}

        {sort}

        {search && (
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={search.value}
              onChange={(e) => search.onChange(e.target.value)}
              placeholder={search.placeholder}
              // placeholder 不能替代无障碍名称——输入框有值之后屏幕阅读器就读不到
              // placeholder 了，补一个 aria-label 兜底
              aria-label={search.placeholder}
              className="h-8 w-[198px] min-w-[120px] rounded-md border border-input bg-card pr-[11px] pl-[30px] text-[13px] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          </div>
        )}

        {action}
      </div>
    </div>
  );
}
