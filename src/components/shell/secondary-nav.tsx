"use client";

import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Check, type LucideIcon } from "lucide-react";

import { SettingTip } from "@/components/setting-tip";
import { cn } from "@/lib/utils";

/**
 * 二级竖向导航（M16 T3）：档案柜抽屉标签面——选中项像一格白色抽屉被"拉出"，
 * 跨过右侧发丝线与内容区材质咬合（`-mr-px w-[calc(100%+1px)]` 就是那 1px 咬合）。
 * 设置页 / 向导 / 命名空间等二级列表共用这一个组件，靠 `queryKey` 区分各自的
 * URL query 键（tab / ns / view / step）。
 *
 * 前导位三选一，是本组件最要紧的判断：固定有序的集合（设置 01–04、向导 01–04）
 * 给编号；用户可增删改的集合（命名空间、任务状态）给数量。给会变的东西发编号
 * 会误导——用户看到"03"会以为它永远排第三。icon 型（M16 T9 新增）留给不是
 * 「有序集合成员」的独立项——如模型编辑页的危险区，它前面不该有编号暗示
 * 「删除是流程的第 6 步」。三种形态共用同一格位置和同一套 mono 样式，语义
 * 不同但不拆成两个组件。
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
  /** 前导位：编号（固定有序集合）/ 计数（用户可增删改的集合）/ 图标
   * （M16 T9 新增，独立项，不是有序集合成员——如危险区），三选一 */
  lead:
    | { kind: "number"; text: string }
    | { kind: "count"; value: number }
    | { kind: "icon"; icon: LucideIcon };
  /** 只有向导用；不传即普通项 */
  state?: "done" | "locked";
  /** 名称后的小标记：running 绿点（"这里有正在跑的东西"）/ alert 红点
   * （"这里有需要注意的异常"，M16 T6 新增，destructive 配色） */
  marker?: { tone: "running" | "alert"; title: string };
  /** 格子本身的原生 title（悬停提示）；目前只有向导的 done/locked 两态会传
   * （"已完成，点击可返回修改" / "完成上一步后解锁"），普通项不传即无提示 */
  title?: string;
  /** 危险区整格转 destructive 配色（M16 T9 新增）：名称/meta/选中态边框全部
   * 转红，不传即普通语义色——设置/模型/文件/下载/向导五个既有调用方不传，
   * 行为不受影响 */
  tone?: "danger";
  /** 路由型项（批 4 新增）：传了就是真跳转，渲染成 Link 而不是写 query 的
   * button——档案是独立路由 /models/repos，不是同一页面的视图切换 */
  href?: string;
  /** 选中态覆盖（批 4 新增）：默认按 key === current 判定，但一个列表里同时
   * 有路由项和 query 项时，单个 current 描述不了两组，此时由调用方显式给 */
  selected?: boolean;
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
  /** 分组：在指定 key 之前插一条分隔线 + 可选小标题；`tip`（批 F 新增，可选）
   * 在小标题右侧挂一个悬浮气泡说明——分组标题本身够短，说明文字放不下，
   * 又不该常驻占地方，所以是 hover/focus 才展开的 tip 而不是常驻小字 */
  groups?: { beforeKey: string; label?: string; tip?: string }[];
  /** 顶部前置区，渲染在 kicker/title 之上（M16 T9 新增，可选）：给「返回上一页」
   * 这类导航出口用——它必须在列表最前面，尤其当列表最后一格是危险区（如模型
   * 编辑页的删除配置）时，出口不能排在一个不可逆操作之后。不传即渲染结果与
   * 现在完全一致，设置/模型/文件/下载/向导五个既有调用方不传，不受影响 */
  header?: ReactNode;
  /** 标题行右侧的小动作（阶段 4 D5 新增，可选）：给「＋新建」这类与列表内容
   * 强相关、但本身不是列表一项的操作用——与 header 的区别是它贴着 title 本身，
   * 一进页面就在视线里，而不是像 header 那样是"进入列表之前"的导航出口。
   * 不传即标题行渲染结果与现在完全一致 */
  titleAction?: ReactNode;
  /** 底部留白区，调用方塞说明或按钮 */
  footer?: ReactNode;
}

const KICKER_CLASS = "font-mono text-xs tracking-[0.14em] text-muted-foreground opacity-70";

interface ItemRowProps {
  item: SecondaryNavItem;
  selected: boolean;
  locked: boolean;
  done: boolean;
  danger: boolean;
  onSelect: () => void;
}

/**
 * 单格的渲染（批 4 拆出）：href 型渲染成 Link、其余渲染成写 query 的
 * button，两者外观必须完全一致（同一个格子只是跳转方式不同），所以样式与
 * 内容只算一份，靠 `item.href` 分岔到两种可交互元素上。
 */
function ItemRow({ item, selected, locked, done, danger, onSelect }: ItemRowProps) {
  const className = cn(
    "group grid w-[calc(100%+1px)] -mr-px grid-cols-[auto_1fr] items-center gap-x-[11px] gap-y-px rounded-l-lg border border-transparent py-[9px] pr-3 pl-[11px]",
    "focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2",
    // disabled:pointer-events-none 顺带关掉了 :hover 命中——locked 项
    // 因此不需要再单独拦一层 !locked 判断
    "disabled:cursor-not-allowed disabled:pointer-events-none disabled:opacity-44",
    !selected && (danger ? "hover:bg-destructive/5" : "hover:bg-foreground/[0.035]"),
    selected && "border-r-card bg-card shadow-[-1px_1px_3px_-1px_rgba(24,24,27,0.09)]",
    selected && (danger ? "border-destructive/25" : "border-border"),
  );

  const content = (
    <>
      <span className="col-span-1 row-span-2 flex items-center gap-[7px]">
        <span
          className={cn(
            "h-px w-[13px] bg-muted-foreground opacity-35",
            !selected && "group-hover:w-[22px] group-hover:opacity-75",
            !selected && danger && "group-hover:bg-destructive",
            done && !selected && "bg-accent-green opacity-85",
            selected && "h-0.5 w-[22px] opacity-100",
            selected && (danger ? "bg-destructive" : "bg-primary"),
          )}
        />
        {/* icon 型前导位（M16 T9 新增）：独立项用图标而非编号——危险区不该被
            读成「有序流程的第 N 步」。danger 语义色钉死在图标本身，不随
            hover/selected 变化色相，只有透明度跟着选中态提亮 */}
        {item.lead.kind === "icon" ? (
          <item.lead.icon
            className={cn(
              "size-3.5 shrink-0",
              danger
                ? cn("text-destructive", selected ? "opacity-100" : "opacity-85")
                : "text-muted-foreground",
            )}
          />
        ) : done && item.lead.kind === "number" ? (
          // done 态的编号前导位换成绿勾（向导专属；lead 是 count 型时不受影响，
          // 设置页/模型页/文件页/下载页都不会命中——它们不传 state）
          <Check className="size-3.5 shrink-0 text-accent-green" />
        ) : (
          <span
            className={cn(
              "font-mono text-xs font-medium tabular-nums text-muted-foreground opacity-80",
              selected && (danger ? "font-semibold text-destructive" : "font-semibold text-primary"),
            )}
          >
            {item.lead.kind === "number" ? item.lead.text : item.lead.value}
          </span>
        )}
      </span>

      <span className="flex min-w-0 items-center gap-1.5">
        <span
          className={cn(
            "truncate text-[13.5px] font-medium",
            danger ? "text-destructive" : "text-muted-foreground",
            !selected && !danger && "group-hover:text-foreground",
            done && !selected && !danger && "text-foreground",
            selected && "font-semibold",
            selected && !danger && "text-foreground",
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
        <span
          className={cn(
            "truncate font-mono text-xs",
            danger ? "text-destructive opacity-58" : "text-muted-foreground opacity-62",
          )}
        >
          {item.meta}
        </span>
      )}
    </>
  );

  // Link 没有 disabled 属性——href 型格子目前没有调用方会传 state: "locked"，
  // 一旦有人真这么传，这个分支不会拦，格子照样可点。刻意不加运行时防御
  // （YAGNI）：先把这条前提写清楚，等真出现该场景再决定怎么拦
  if (item.href !== undefined) {
    return (
      <Link
        href={item.href}
        aria-current={selected ? "page" : undefined}
        title={item.title}
        className={className}
      >
        {content}
      </Link>
    );
  }

  return (
    <button
      type="button"
      disabled={locked}
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      title={item.title}
      className={className}
    >
      {content}
    </button>
  );
}

export function SecondaryNav({
  kicker,
  title,
  items,
  queryKey,
  current,
  groups,
  header,
  titleAction,
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
    // aria-label 用 title：这是页内第二个 nav 地标（侧栏是第一个），
    // 不给名字屏幕阅读器只会报两个同名的「导航」，分不出哪个是哪个
    <nav
      aria-label={title}
      className="flex w-[236px] shrink-0 flex-col border-r border-border/50 bg-background"
    >
      {header}
      <div className="px-4 pt-5 pb-3.5">
        <div className={KICKER_CLASS}>{kicker}</div>
        <div className="mt-[3px] flex items-center justify-between gap-2">
          <div className="truncate text-[15px] font-semibold">{title}</div>
          {titleAction}
        </div>
      </div>

      {/* 只有这份列表该滚：kicker/title/titleAction 是身份区、footer 是说明/出口，
          两者都得固定可见；命名空间/档案多起来时应该是列表自己长出滚动条，
          不是把 footer 挤出视口或把整个 nav 拖成跟着页面一起滚的长条 */}
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pl-3 pt-0.5">
        {items.map((item) => {
          const group = groups?.find((g) => g.beforeKey === item.key);
          const selected = item.selected ?? item.key === current;
          const locked = item.state === "locked";
          const done = item.state === "done";
          const danger = item.tone === "danger";

          return (
            <Fragment key={item.key}>
              {group && (
                <>
                  <div className="mx-3 my-[7px] h-px bg-border/50" />
                  {group.label && (
                    // flex + gap 让 tip 图标与标签横向并排：图标不参与 truncate，
                    // 标签自己 min-w-0 收缩，长标签会截断而不是把图标挤到下一行
                    <div className={cn(KICKER_CLASS, "flex items-center gap-1 px-2 pb-1.5")}>
                      <span className="min-w-0 truncate">{group.label}</span>
                      {group.tip && <SettingTip text={group.tip} />}
                    </div>
                  )}
                </>
              )}
              <ItemRow
                item={item}
                selected={selected}
                locked={locked}
                done={done}
                danger={danger}
                onSelect={() => handleSelect(item.key)}
              />
            </Fragment>
          );
        })}
      </div>

      {footer}
    </nav>
  );
}
