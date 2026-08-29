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
  /** 读数下方的小标签，用来把语义钉死（"模型" / "运行中" / "占盘"） */
  label: string;
  /** hot 时主值走 primary 色，用于该页最该被看见的那个数（每页至多一个） */
  tone?: "hot";
}

interface PageHeaderProps {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  stats?: StatItem[];
  /** 顶栏右侧自定义内容；与 stats 互斥（都靠右，同时给会挤），调用方二选一 */
  trailing?: ReactNode;
}

/**
 * 全站顶栏统一语法（M16 T2）：页面图标 + 等宽标题 + 短 mono 副题 ··· 右侧指标排。
 * 标题走等宽字体是刻意的——这套界面里"机器身份"（命名空间名、文件名、端口、
 * 容器名）一律等宽展示，页面标题跟着走，科技感由字体本身承担，不靠装饰横线。
 * 顶栏只放身份与读数，控件（搜索/主操作/筛选）一律下沉到工具条（T3 接线）。
 *
 * `trailing`（M16 T4a 增）：给不适合读数排的右侧内容（如深链胶囊）留的插槽，
 * 与 `stats` 互斥，同时传只渲染 `stats`——两者都靠右，叠在一起会挤成一团。
 */
export function PageHeader({ icon: Icon, title, subtitle, stats, trailing }: PageHeaderProps) {
  return (
    <div className="flex items-end gap-4 border-b border-border/50 px-7 pt-4 pb-3.5">
      <span className="flex size-[34px] shrink-0 items-center justify-center self-center rounded-lg bg-primary/10 text-primary">
        <Icon className="size-[18px]" />
      </span>

      <div className="min-w-0">
        <h1 className="truncate font-mono text-[21px] font-semibold leading-[1.18] tracking-[-0.005em]">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1 truncate font-mono text-xs text-muted-foreground opacity-80">
            {subtitle}
          </p>
        )}
      </div>

      {stats && stats.length > 0 && (
        <div className="ml-auto flex items-stretch">
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
    </div>
  );
}
