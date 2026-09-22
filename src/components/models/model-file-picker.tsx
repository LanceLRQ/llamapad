"use client";

import { useMemo, useState } from "react";
import { Box, Check, Folder, FolderOpen, Image as ImageIcon, Layers, Search, Zap } from "lucide-react";
import { useTranslations } from "next-intl";

import {
  PICKER_PURPOSE,
  buildPickerDirTree,
  countByKind,
  filterByDirPrefix,
  filterPickerItems,
  groupByDir,
  listSecondaryKinds,
  partitionByAccept,
  pickerKindOf,
  resolveInitialDir,
  type PickerDirNode,
  type PickerField,
  type PickerGroup,
  type PickerItem,
  type PickerKind,
  type PickerPurpose,
} from "@/lib/model-file-picker";
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
import { Input } from "@/components/ui/input";

/** 类型筛选分段控件覆盖的全部类别，固定顺序（供「accept 外出现过的类别」补位用） */
const ALL_KINDS: readonly PickerKind[] = ["model", "mmproj", "mtp"];

/**
 * 模型文件选择弹层（规格 §4；2026-09-21 改版为双栏文件浏览器）：数据来自 server
 * component 直接下发的文件树，不发请求、无 loading 态。
 *
 * 三条刻意的设计：
 * - **accept 只分类不过滤**：`field`/`accept` 决定的是这次弹层的「用途」，不是
 *   候选的准入条件——mmproj/MTP 挂件的识别全靠文件名前缀与 GGUF 元数据推断，
 *   两者都有判错的可能（`mtp-kind.ts` 头注释举过文件名不可信的实例：带 MTP
 *   字样的其实是主模型，不带的反而内嵌了 MTP 头）。一旦把判定结果当硬过滤
 *   条件用，误判就会把用户真正想选的文件从列表里彻底拿掉，连手动救济的机会
 *   都没有。所以这里全程只用 `partitionByAccept` 把候选分成「命中，排前面」
 *   与「未命中，折到分隔线以下弱化展示」两块，未命中的一样可点、可双击确认——
 *   `.filter()` 删候选在这个组件里是禁用写法。
 * - **输入框保持可编辑**：弹层是辅助不是替代。调用方（如 model-params-form.tsx）
 *   那个文本框始终留着，glob 形态、尚未落盘的路径这类情况仍然需要手输。
 * - **左栏目录树 + 右栏文件列表**：models 目录按用户自建层级组织，一份
 *   `pickerItems` 可能横跨十几个子目录，摊平成一条长列表找文件全靠肉眼数行。
 *   树把「在哪」和「是什么」拆成两步：左边先定位目录，右边只看这一层（含子
 *   目录）的候选。两栏共享同一份 `items`，但左栏建树时用的是**未经**搜索词/
 *   类别筛选的全量数据（`buildPickerDirTree`）——树是浏览器的骨架，用户在
 *   输入框打字时骨架跟着抖动会让人瞬间迷失当前站在哪个目录。
 */
export function ModelFilePicker({
  items,
  field,
  accept,
  onSelect,
  namespace,
  trigger,
  open: openProp,
  onOpenChange: onOpenChangeProp,
  descriptionParams,
  locateFile,
}: {
  items: PickerItem[];
  /** 决定标题与默认 accept（`PICKER_PURPOSE[field]`）；"draft" 是加速权重
   *  选择器，默认把 MTP 挂件（sidecar）挪到最前 */
  field: PickerField;
  /** 显式覆盖本次允许选的类别；不给就用 `PICKER_PURPOSE[field]`。「accept 不
   *  隐藏候选」这条原则在这里同样成立：只决定谁排前面、谁归进 secondary，
   *  不会让任何候选从列表里消失 */
  accept?: readonly PickerKind[];
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
  /** 打开弹层时把左栏目录树定位到这个文件所在的目录（通常传当前已选的主权重
   *  路径）。定位不到就落回 models 根 */
  locateFile?: string;
}) {
  const t = useTranslations("common.filePicker");
  const tCustom = useTranslations(namespace ?? "common.filePicker");
  // 拼接多个类别名时用的连接符：中文顿号、英文逗号+空格。走 i18n 键而不是
  // 在组件里按 locale 分支判断——本仓库已有先例（pages.modelEdit.listSeparator，
  // model-params-form.tsx 里 t("listSeparator") 的同款用法），语言判断留在
  // 文案层，逻辑层不该为了一个标点符号多认一种语言
  const kindsJoiner = t("listSeparator");
  const kindLabel = (kind: PickerKind) =>
    kind === "mmproj" ? t("kindMmproj") : kind === "mtp" ? t("kindMtp") : t("kindModel");

  const purpose: PickerPurpose = accept !== undefined ? { accept, prefer: accept[0] } : PICKER_PURPOSE[field];

  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : internalOpen;

  // 目录树吃全量 items，不受下面的搜索词/类别筛选影响，见头注释
  const dirTree = useMemo(() => buildPickerDirTree(items), [items]);

  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<PickerKind | "all">("all");
  const [dirPath, setDirPath] = useState("");

  function resetFilters() {
    setSelected(null);
    setQuery("");
    setKindFilter("all");
    // 定位到 locateFile 所在目录（通常是当前已选的主权重路径），定位不到
    // 就落回 models 根——两种情况都由 resolveInitialDir 内部处理。
    // 这里引用的 `dirTree` 是上方那个 useMemo 的产出：它必须声明在本函数
    // 的调用点（下方那段渲染期 if 块）之前，否则会撞暂时性死区。这也是
    // `dirTree` 的 useMemo 被放在一堆 useState 之上、而不是跟其余几个
    // 派生数据的 useMemo 排在一起的唯一原因——hook 调用顺序保持稳定即可，
    // 位置本身不影响正确性
    setDirPath(resolveInitialDir(dirTree, locateFile ?? ""));
  }

  /**
   * 每次打开都把筛选状态清空：上一轮挑选留下的搜索词、选中项，都是这一次
   * 会话的临时状态，留到下一次会让用户以为弹层记得他选了什么（其实只是
   * 渲染残留）。
   *
   * 用"渲染期比对上一次 open"而不是在 `handleOpenChange` 里重置：受控用法
   * （如 repo-detail-view.tsx 的手动关联弹层）由外层直接翻转 `open` prop，
   * 根本不经过 `handleOpenChange`——Base UI 的 `useControlled`
   * （`@base-ui/utils/useControlled`）证实受控模式下父组件改 `open` 不会
   * 触发子组件收到的 `onOpenChange` 回调，只在 `handleOpenChange` 里重置会
   * 漏掉这一路，导致反复开关的受控弹层（该弹层的常态用法）带着上一轮的
   * 搜索词/选中项再次打开。渲染期比对能同时覆盖受控与非受控两条路径；
   * 也不用 `useEffect` 追 `open`——那样会在首帧额外多跑一次，还会在关闭
   * 动画播放期间就把状态清空，用户能看到列表在弹层淡出的同时闪一下变成
   * "全部未选中"。
   *
   * `prevOpen` 初值顺手从 `useState(open)` 改成了 `useState(false)`：初值
   * 取 `open` 时，一个"挂载时就已经是打开态"的调用方会让 `prevOpen ===
   * open` 从第一帧起就恒成立，下面的 `if (open !== prevOpen)` 永远不触发，
   * `resetFilters`（连同这次要接的 `locateFile` 定位）也就不会在首次打开
   * 时跑一遍，定位无从生效。取 `false` 则挂载即打开的情况也能正确走一遍
   * 重置；`open` 为 `false` 时挂载，`prevOpen` 同样是 `false`，两者相等，
   * 行为与改前完全一致，不受影响。
   */
  const [prevOpen, setPrevOpen] = useState(false);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) resetFilters();
  }

  function handleOpenChange(next: boolean) {
    if (isControlled) onOpenChangeProp?.(next);
    else setInternalOpen(next);
  }

  function confirm(value: string) {
    onSelect(value);
    handleOpenChange(false);
  }

  function onConfirmClick() {
    if (selected !== null) confirm(selected);
  }

  // 数据流（顺序固定，见组件契约文档）：目录 → 搜索 → 类别 → 命中/未命中
  // 分区 → 各自按目录分组
  const dirFiltered = useMemo(() => filterByDirPrefix(items, dirPath), [items, dirPath]);
  // 类型筛选分段控件的计数基于「当前目录」，不叠加搜索词——搜索打到一半时
  // 分段控件的数字跟着抖动没有意义，用户此刻想知道的是这个目录下有多少
  const dirCounts = countByKind(dirFiltered);
  const searched = useMemo(() => filterPickerItems(dirFiltered, query), [dirFiltered, query]);
  const kindFiltered =
    kindFilter === "all" ? searched : searched.filter((item) => pickerKindOf(item) === kindFilter);
  const { primary, secondary } = partitionByAccept(kindFiltered, purpose);
  const primaryGroups = groupByDir(primary);
  const secondaryGroups = groupByDir(secondary);

  // 类型筛选分段控件的按钮集合取自全量 items，不随当前目录变化：分段控件是
  // 常驻控件不是内容，点目录树切换时如果按钮跟着整排跳动，用户会找不着刚才
  // 点的那个位置。全部 + accept 声明的类别恒显示（哪怕这个目录下是 0，见下方
  // disabled），accept 外的类别只要在全量候选里出现过也恒显示——两者同一口径，
  // 不因为在不在 accept 里就换一套"要不要显示"的规则；实际会显示的数字仍然
  // 跟着当前目录走（dirCounts）
  const allCounts = countByKind(items);
  const extraKinds = ALL_KINDS.filter((kind) => !purpose.accept.includes(kind) && allCounts[kind] > 0);
  const kindSegments: readonly (PickerKind | "all")[] = ["all", ...purpose.accept, ...extraKinds];

  const title =
    namespace !== undefined
      ? tCustom("manualPickerTitle")
      : t(field === "mmproj" ? "titleMmproj" : field === "draft" ? "titleDraft" : "titleGguf");
  const subtitle =
    namespace !== undefined
      ? tCustom("manualPickerHint", descriptionParams)
      : t("acceptLine", { kinds: purpose.accept.map(kindLabel).join(kindsJoiner) });

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
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
      {/* 基类自带 grid gap-4 p-4 sm:max-w-sm——不带 sm: 前缀直接传 max-w 会被它在
          ≥640px 下盖掉（弹层被锁死在 384px 的坑），这里连同 display/gap/padding
          一起用带前缀的写法整体覆盖 */}
      <DialogContent className="flex h-[min(632px,86vh)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(960px,92vw)]">
        <DialogHeader className="gap-1 px-4 pt-4 pb-2">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{subtitle}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2.5 px-4 pb-3">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder={t("searchPlaceholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div role="group" className="flex items-center gap-0.5 rounded-lg bg-secondary p-0.5">
            {kindSegments.map((segment) => {
              const count = segment === "all" ? dirFiltered.length : dirCounts[segment];
              const pressed = kindFilter === segment;
              const disabled = segment !== "all" && count === 0;
              return (
                <button
                  key={segment}
                  type="button"
                  aria-pressed={pressed}
                  disabled={disabled}
                  onClick={() => setKindFilter(segment)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors",
                    pressed ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                    disabled && "cursor-not-allowed opacity-50",
                  )}
                >
                  {segment === "all" ? t("filterAll") : kindLabel(segment)}
                  <span className="ml-1 text-muted-foreground/80">{count}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 border-t sm:grid-cols-[236px_1fr]">
          {/* 左栏在窄屏隐藏，主体退化成单列——236px 的目录树在手机宽度下挤不出
              空间给文件列表，此时只留搜索+类型筛选做导航 */}
          <nav className="hidden overflow-y-auto border-r bg-muted/30 p-2 sm:block">
            <p className="px-2 pt-1 pb-1.5 text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">
              {t("dirHeading")}
            </p>
            {dirTree.map((node) => (
              <DirTreeRow
                key={node.path}
                node={node}
                active={node.path === dirPath}
                rootLabel={t("rootGroupLabel")}
                onClick={() => setDirPath(node.path)}
              />
            ))}
          </nav>

          <div className="overflow-y-auto p-2">
            {items.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                {namespace !== undefined ? tCustom("manualPickerEmpty") : t("empty")}
              </p>
            ) : primaryGroups.length === 0 && secondaryGroups.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">{t("emptyFiltered")}</p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {primaryGroups.map((group) => (
                  <PickerGroupSection
                    key={group.dir}
                    group={group}
                    rootLabel={t("rootGroupLabel")}
                    selectedValue={selected}
                    onSelect={setSelected}
                    onConfirm={confirm}
                  />
                ))}
                {secondaryGroups.length > 0 && (
                  <li className="my-2 rounded-md bg-secondary px-2.5 py-1.5 text-[11.5px] text-muted-foreground">
                    {t("secondaryNote", {
                      kinds: listSecondaryKinds(secondary).map(kindLabel).join(kindsJoiner),
                    })}
                  </li>
                )}
                {secondaryGroups.map((group) => (
                  <PickerGroupSection
                    key={group.dir}
                    group={group}
                    rootLabel={t("rootGroupLabel")}
                    selectedValue={selected}
                    dimmed
                    onSelect={setSelected}
                    onConfirm={confirm}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* 基类的 -mx-4 -mb-4 是按它自己的 p-4 内边距算的抵消值，DialogContent
            这里已经整体覆盖成 p-0，footer 要连同 mx/mb 一起清零重设，否则会
            把自己往外拉出 16px。sm:justify-end 同理必须用同前缀的
            sm:justify-between 覆盖——两者变体不同，裸 justify-between 在
            ≥640px 下盖不掉它，就是本次要修的那个 sm: 坑本身 */}
        <DialogFooter className="mx-0 mb-0 flex-row items-center justify-between gap-3 border-t bg-muted/50 p-4 sm:flex-row sm:justify-between">
          <div className="min-w-0 flex-1">
            <p className="text-[10.5px] text-muted-foreground">{t("selectedLabel")}</p>
            <p className="truncate font-mono text-xs">{selected ?? "—"}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <DialogClose render={<Button type="button" variant="outline" />}>{t("cancel")}</DialogClose>
            <Button type="button" disabled={selected === null} onClick={onConfirmClick}>
              <Check className="size-3.5" />
              {t("confirm")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 左栏目录树的一行：缩进用行内 style 而非动态类名——Tailwind 编译期静态
 *  扫描扫不到 `paddingLeft: 8 + depth * 12` 这种运行时拼出来的类名 */
function DirTreeRow({
  node,
  active,
  rootLabel,
  onClick,
}: {
  node: PickerDirNode;
  active: boolean;
  rootLabel: string;
  onClick: () => void;
}) {
  const Icon = active ? FolderOpen : Folder;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active || undefined}
      style={{ paddingLeft: 8 + node.depth * 12 }}
      className={cn(
        "flex h-[30px] w-full items-center gap-1.5 rounded-md pr-2 text-left text-[12.5px] transition-colors hover:bg-accent",
        active && "bg-primary/12 font-medium text-primary",
      )}
    >
      <Icon className={cn("size-3.5 shrink-0 text-muted-foreground", active && "text-primary")} />
      <span className="min-w-0 flex-1 truncate">{node.path === "" ? rootLabel : node.label}</span>
      <span className="text-[11px] text-muted-foreground">{node.count}</span>
    </button>
  );
}

/**
 * 一个目录分组：mono 小标题（延伸到右边的细横线收尾，对照原型）+ 缩进的行。
 * `dimmed` 透传给标题与每一行，让 secondary 区（accept 未命中的候选）整体
 * 弱化，沿用改版前 `PickerDirGroup` 的同款机制。
 */
function PickerGroupSection({
  group,
  rootLabel,
  selectedValue,
  dimmed,
  onSelect,
  onConfirm,
}: {
  group: PickerGroup;
  rootLabel: string;
  selectedValue: string | null;
  dimmed?: boolean;
  onSelect: (value: string) => void;
  onConfirm: (value: string) => void;
}) {
  // dir === "" 是根下文件：渲染成 "" + "/" 会得到一个孤零零的斜杠，看不出
  // 这一组是什么，改成明确的"models 根"标题。title 属性给深层路径一个
  // hover 全文——truncate 只保证不撑破布局，不保证用户能看全被截断的部分
  const label = group.dir === "" ? rootLabel : `${group.dir}/`;
  return (
    <>
      <li
        title={group.dir === "" ? undefined : group.dir}
        className={cn(
          "flex items-center gap-2 px-1 pt-3 pb-1 font-mono text-[11px] text-muted-foreground",
          dimmed && "opacity-55",
        )}
      >
        <span className="truncate">{label}</span>
        <span className="h-px flex-1 bg-border" />
      </li>
      {group.items.map((item) => (
        <PickerRow
          key={item.value}
          item={item}
          selected={item.value === selectedValue}
          dimmed={dimmed}
          onSelect={() => onSelect(item.value)}
          onConfirm={() => onConfirm(item.value)}
        />
      ))}
    </>
  );
}

/**
 * 一行候选：左侧类别图标块 / 文件名 + 量化 + MTP 徽标 + 引用数或未使用徽标 +
 * 分片徽标 / 体积 / 选中勾。单击选中（不关弹层）、双击选中并确认；`dimmed`
 * 是 secondary 区（accept 未命中）的弱化项，一样可点。
 */
function PickerRow({
  item,
  selected,
  dimmed,
  onSelect,
  onConfirm,
}: {
  item: PickerItem;
  selected: boolean;
  dimmed?: boolean;
  onSelect: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations("common.filePicker");
  const kind = pickerKindOf(item);
  const Icon = kind === "mmproj" ? ImageIcon : kind === "mtp" ? Zap : Box;
  const incomplete = item.shardTotalDeclared !== null && item.shards !== item.shardTotalDeclared;

  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        onDoubleClick={onConfirm}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent",
          selected && "bg-primary/9 ring-1 ring-primary/35",
          dimmed && "opacity-55",
        )}
      >
        <span
          className={cn(
            "flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground",
            selected && "bg-primary/15 text-primary",
          )}
        >
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-sm">{item.label}</span>
          <span className="flex flex-wrap items-center gap-1.5 pt-0.5 text-[11px] text-muted-foreground">
            <span>{item.quant ?? t("quantUnknown")}</span>
            {item.mtpKind !== "none" && (
              // MTP 标签升级成徽标（改版前是纯文本 + "·" 分隔）：sidecar/embedded
              // 各自固定一套颜色，是原型里挑出来的关键可扫描性来源——列表一眼
              // 扫过去，颜色比文字先被注意到
              <Badge
                variant="outline"
                className={
                  item.mtpKind === "sidecar"
                    ? "border-primary/35 bg-primary/10 text-primary"
                    : "border-accent-green/30 bg-accent-green/10 text-accent-green"
                }
              >
                {t(item.mtpKind === "embedded" ? "mtpEmbeddedBadge" : "mtpSidecarBadge")}
              </Badge>
            )}
            {item.refs > 0 ? (
              <span>{t("refs", { count: item.refs })}</span>
            ) : (
              // refs === 0 不是"没信息"而是"还没人用"——这正是用户来选文件时
              // 最想先看到的那批，之前它与已被占用的文件长得一模一样
              <Badge variant="outline" className="px-1.5 text-[10px] text-muted-foreground">
                {t("unused")}
              </Badge>
            )}
            {item.shardTotalDeclared !== null && (
              <Badge
                variant="outline"
                className={cn(
                  "gap-1 px-1.5 text-[10px]",
                  incomplete && "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
                )}
              >
                <Layers className="size-3" />
                {incomplete
                  ? t("shardsIncomplete", { found: item.shards, declared: item.shardTotalDeclared })
                  : t("shards", { count: item.shards })}
              </Badge>
            )}
          </span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatSize(item.totalSize)}</span>
        <span className="flex size-4 shrink-0 items-center justify-center text-primary">
          {selected && <Check className="size-4" />}
        </span>
      </button>
    </li>
  );
}
