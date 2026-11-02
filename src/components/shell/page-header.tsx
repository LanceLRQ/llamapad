import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { formatStat } from "@/lib/page-header";
import { cn } from "@/lib/utils";

/**
 * 顶栏右侧一枚读数：主值 + 可选单位 + 语义标签。value 为 null/0（含字符串
 * 形态的 "0"/""）时由 formatStat 判定为空态，整列弱化展示——判定逻辑见
 * lib/page-header.ts，此处只负责渲染。
 */
export interface StatItem {
  /** 读数主值；null 表示"没有这个数"（渲染成 — 并降透明度） */
  value: string | number | null;
  /** 值后缀单位，如 "GB"，比主值小一号且弱化 */
  unit?: string;
  /** 读数下方的小标签，用来把语义钉死（"模型" / "运行中" / "存储空间占用"） */
  label: string;
  /** hot 时主值走 primary 色，用于该页最该被看见的那个数（每页至多一个） */
  tone?: "hot";
}

interface PageHeaderProps {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  /** 标题旁垂直居中的筛选控件。 */
  titleAction?: ReactNode;
  stats?: StatItem[];
  /** 顶栏右侧自定义内容；与 stats 互斥（都靠右，同时给会挤），调用方二选一 */
  trailing?: ReactNode;
  /** 与页头读数并列的独立创建操作。 */
  action?: ReactNode;
}

/**
 * 页头展示身份、筛选与读数，标题使用正文字体。
 * 窄屏允许换行，长标题不通过截断隐藏。
 *
 * `trailing`（M16 T4a 增）：给不适合读数排的右侧内容（如深链胶囊）留的插槽，
 * 与 `stats` 互斥，同时传只渲染 `stats`——两者都靠右，叠在一起会挤成一团。
 */
export function PageHeader({ icon: Icon, title, subtitle, titleAction, stats, trailing, action }: PageHeaderProps) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-border/50 px-4 pt-4 pb-3.5 sm:px-7">
      <span className="hidden size-[34px] shrink-0 items-center justify-center self-center text-muted-foreground sm:flex">
        <Icon className="size-[18px]" />
      </span>

      <div className={cn("min-w-0 flex-1", titleAction && "flex basis-full flex-wrap items-center gap-x-4 gap-y-2 sm:basis-0")}>
        <div className="min-w-0 max-w-full">
          <h1 className="break-words text-xl font-semibold leading-tight tracking-[-0.005em]">
            {title}
          </h1>
          {subtitle && (
            <p className="mt-1 truncate font-mono text-xs text-muted-foreground opacity-80">
              {subtitle}
            </p>
          )}
        </div>
        {titleAction}
      </div>

      {stats && stats.length > 0 && (
        <div className="ml-auto flex max-w-full items-stretch overflow-x-auto">
          {stats.map((stat, index) => {
            const display = formatStat(stat.value, stat.unit);
            return (
              <div
                key={stat.label}
                className={cn(
                  "flex flex-col items-end border-l border-border/50 px-[15px]",
                  index === 0 && "border-l-0",
                  index === stats.length - 1 && "pr-0",
                  display.empty && "text-muted-foreground opacity-55",
                )}
              >
                <span
                  className={cn(
                    "font-mono text-[19px] font-semibold leading-[1.15] tabular-nums",
                    stat.tone === "hot" && !display.empty && "text-primary",
                  )}
                >
                  {display.text}
                  {display.unit && (
                    <span className="ml-1 text-xs font-medium text-muted-foreground">
                      {display.unit}
                    </span>
                  )}
                </span>
                <span className="mt-px text-[11.5px] text-muted-foreground">{stat.label}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* stats 优先：两者同时传只渲染 stats，忽略 trailing，避免右侧挤成一团 */}
      {!(stats && stats.length > 0) && trailing && (
        <div className="ml-auto flex items-center">{trailing}</div>
      )}
      {action && <div className="flex shrink-0 items-center">{action}</div>}
    </div>
  );
}
