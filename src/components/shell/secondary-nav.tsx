"use client";

import { Fragment, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { cn } from "@/lib/utils";

/**
 * 二级竖向导航（M16 T3）：档案柜抽屉标签面——选中项像一格白色抽屉被"拉出"，
 * 跨过右侧发丝线与内容区材质咬合（`-mr-px w-[calc(100%+1px)]` 就是那 1px 咬合）。
 * 设置页 / 向导 / 命名空间等二级列表共用这一个组件，靠 `queryKey` 区分各自的
 * URL query 键（tab / ns / view / step）。
 *
 * 前导位二选一，是本组件最要紧的判断：固定有序的集合（设置 01–04、向导 01–04）
 * 给编号；用户可增删改的集合（命名空间、任务状态）给数量。给会变的东西发编号
 * 会误导——用户看到"03"会以为它永远排第三。两种形态共用同一格位置和同一套
 * mono 样式，语义不同但不拆成两个组件。
 *
 * 选中态走 URL query 而非路由跳转：本组件内部用 router.replace 写 query，
 * 不新增历史栈条目（同一个二级列表内切换不该塞满浏览器后退栈）；`current`
 * 由调用方从 searchParams 解析后传入，本组件不自己读它，只在"写"的时候
 * 需要拿到当前完整 query 去追加/覆盖一个键，其余已有参数原样保留
 * （比如 `?q=xxx` 的搜索词不能被切 tab 冲掉）。
 */

interface SecondaryNavItem {
  /** 写进 URL query 的值 */
  key: string;
  name: string;
  /** 名称下方一行 mono 小字，常驻展示，不是 hover 才出现 */
  meta?: string;
  /** 前导位：编号（固定有序集合）或计数（用户可增删改的集合），二选一 */
  lead: { kind: "number"; text: string } | { kind: "count"; value: number };
  /** 只有向导用；不传即普通项 */
  state?: "done" | "locked";
  /** 名称后的小标记：running 绿点（"这里有正在跑的东西"）/ alert 红点
   * （"这里有需要注意的异常"，M16 T6 新增，destructive 配色） */
  marker?: { tone: "running" | "alert"; title: string };
}

interface SecondaryNavProps {
  /** 顶部 mono 全大写小标，如 "SETTINGS" */
  kicker: string;
  /** kicker 下方的标题 */
  title: string;
  items: SecondaryNavItem[];
  /** URL query 的键名，由调用方给：tab / ns / view / step */
  queryKey: string;
  /** 当前选中项；调用方从 searchParams 解析后传入 */
  current: string;
  /** 分组：在指定 key 之前插一条分隔线 + 可选小标题 */
  groups?: { beforeKey: string; label?: string }[];
  /** 底部留白区，调用方塞说明或按钮 */
  footer?: ReactNode;
}

const KICKER_CLASS = "font-mono text-xs tracking-[0.14em] text-muted-foreground opacity-70";

export function SecondaryNav({
  kicker,
  title,
  items,
  queryKey,
  current,
  groups,
  footer,
}: SecondaryNavProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function handleSelect(key: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(queryKey, key);
    // scroll: false——只是切二级列表里的一个 tab，不该把内容区滚回顶部
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  return (
    <nav className="flex w-[236px] shrink-0 flex-col border-r border-border/50 bg-background">
      <div className="px-4 pt-5 pb-3.5">
        <div className={KICKER_CLASS}>{kicker}</div>
        <div className="mt-[3px] text-[15px] font-semibold">{title}</div>
      </div>

      <div className="flex flex-col gap-0.5 pl-3 pt-0.5">
        {items.map((item) => {
          const group = groups?.find((g) => g.beforeKey === item.key);
          const selected = item.key === current;
          const locked = item.state === "locked";
          const done = item.state === "done";

          return (
            <Fragment key={item.key}>
              {group && (
                <>
                  <div className="mx-3 my-[7px] h-px bg-border/50" />
                  {group.label && <div className={cn(KICKER_CLASS, "px-2 pb-1.5")}>{group.label}</div>}
                </>
              )}
              <button
                type="button"
                disabled={locked}
                onClick={() => handleSelect(item.key)}
                aria-current={selected ? "true" : undefined}
                className={cn(
                  "group grid w-[calc(100%+1px)] -mr-px grid-cols-[auto_1fr] items-center gap-x-[11px] gap-y-px rounded-l-lg border border-transparent py-[9px] pr-3 pl-[11px]",
                  "focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2",
                  // disabled:pointer-events-none 顺带关掉了 :hover 命中——locked 项
                  // 因此不需要再单独拦一层 !locked 判断
                  "disabled:cursor-not-allowed disabled:pointer-events-none disabled:opacity-44",
                  !selected && "hover:bg-foreground/[0.035]",
                  selected &&
                    "border-border border-r-card bg-card shadow-[-1px_1px_3px_-1px_rgba(24,24,27,0.09)]",
                )}
              >
                <span className="col-span-1 row-span-2 flex items-center gap-[7px]">
                  <span
                    className={cn(
                      "h-px w-[13px] bg-muted-foreground opacity-35",
                      !selected && "group-hover:w-[22px] group-hover:opacity-75",
                      done && !selected && "bg-accent-green opacity-85",
                      selected && "h-0.5 w-[22px] bg-primary opacity-100",
                    )}
                  />
                  <span
                    className={cn(
                      "font-mono text-xs font-medium tabular-nums text-muted-foreground opacity-80",
                      selected && "font-semibold text-primary",
                    )}
                  >
                    {item.lead.kind === "number" ? item.lead.text : item.lead.value}
                  </span>
                </span>

                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    className={cn(
                      "truncate text-[13.5px] font-medium text-muted-foreground",
                      !selected && "group-hover:text-foreground",
                      done && !selected && "text-foreground",
                      selected && "font-semibold text-foreground",
                    )}
                  >
                    {item.name}
                  </span>
                  {item.marker && (
                    <span
                      title={item.marker.title}
                      className={cn(
                        "size-1.5 shrink-0 rounded-full ring-[3px]",
                        item.marker.tone === "alert"
                          ? "bg-destructive ring-destructive/20"
                          : "bg-accent-green ring-accent-green/20",
                      )}
                    />
                  )}
                </span>

                {item.meta && (
                  <span className="truncate font-mono text-xs text-muted-foreground opacity-62">
                    {item.meta}
                  </span>
                )}
              </button>
            </Fragment>
          );
        })}
      </div>

      {footer}
    </nav>
  );
}
