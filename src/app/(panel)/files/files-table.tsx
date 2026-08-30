"use client";

import { Fragment, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Folder,
  FolderInput,
  Layers,
  Loader2,
  Lock,
  MoreHorizontal,
  Pencil,
  SortAsc,
  SortDesc,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { shardGroup } from "@/core/files";
import { applyFileQuery, fileName, type FileQuery, type FileSortDir, type FileSortKey } from "@/lib/file-list";
import { buildShardIndex, type ShardIndexEntry } from "@/lib/file-shards";
import { formatSize } from "@/lib/format";
import { computeChipCounts } from "@/lib/toolbar-counts";
import { cn } from "@/lib/utils";
import { Toolbar } from "@/components/shell/toolbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiFetch } from "@/lib/api";
import { toast } from "@/components/toast-store";

/**
 * 文件浏览交互组件（M1 Task 11，U21 加搜索/排序/批量删除；M16 T6 拍平文件
 * 夹从「每个文件夹一张 Card」收进左侧二级栏切片，四张卡拍平成一张表，
 * 筛选/搜索/排序挂进表格上方的 Toolbar——文件夹这一维已经交给二级栏，
 * 组内再单独起一张 Card 卡头是冗余）。
 *
 * 分片成组（M16 T6 改排序无关）：以前靠 scanTree 按 rel 排序后"相邻"推组，
 * 按 size/mtime 排序会打散相邻关系，分片徽标（"×N"）就跟着不准了。现在
 * buildShardIndex（lib/file-shards.ts）从该命名空间的全量文件（与查询、
 * 排序完全无关）建索引，buildRows 的 groupSize 一律从索引取——徽标上的
 * 组内文件数不再随排序变化；`first`/`last` 仍按当前渲染顺序的相邻性算，
 * 它们只控制视觉上的连接线与去边框，本来就该跟着实际呈现顺序走，按什么
 * 排序连接线跟着断是正常的，不是缺陷。
 *
 * 三态删除（点击先 GET /files/refs 再分派，服务端为最终裁决）：
 * - locked：SSR 已知（页面传入 locked 集合）按钮直接禁用 + 锁徽标；
 *   页面加载后模型才启动的竞态 → 拉 refs 发现 runningLocked，行内报错
 * - refs>0：确认 Dialog 列出引用配置 + 强制删除 checkbox（未勾选禁用确认）
 *   + 同组分片提示（siblings，只提示不自动删组）
 * - refs=0：简单确认 Dialog
 * 确认后 DELETE /api/v1/files { path, force } → router.refresh()；
 * 409/423/404 竞态错误显示在行内。
 *
 * 批量删除：勾选跨分组的行（表头 checkbox 全选/取消全选当前可见行，
 * 三态用 indeterminate 表示部分选中），浮出操作条统计已选数量与总大小。
 * locked 集合已是 SSR 传入的既有 prop，无需逐个文件再拉 refs——确认框
 * 直接用 selected ∩ locked 算出「M 个将被跳过」。批量请求恒带
 * force:true（对齐单文件流程里"确认强制删除"的语义），但 LOCKED 在
 * 服务端无论 force 都不放行（风险簿第 8 条），所以锁定项即使勾选也只会
 * 被服务端跳过，不会误删。
 *
 * 移动 / 改名（T2，设计 §2；A6 改目标目录校验口径，见 server/filesApi.ts
 * planFileMove 顶部注释）：行操作菜单（⋯）新增两项，均先拉一次
 * GET /files/refs 拿引用清单 + 同组分片（siblings）供确认框展示，再分派
 * POST /api/v1/files/move（body 键是 toFolder）或 /rename。与删除不同：
 * 移动/改名总是同步全部引用，不提供"仅挪文件"的旁路（决策 9），确认框只
 * 展示不提供勾选跳过；分片组一律整组操作——移动列出组内全部文件，改名框
 * 只能编辑前缀、序号段灰显（决策 7）。错误响应走 `{ error: CODE, message }`
 * 契约（与删除的 `{ error: 消息文本 }` 不同），按 code 映射到对应文案。
 */

/** 一行文件数据（与 filesApi.TreeFile 结构兼容，客户端不引 server 模块） */
export interface FilesEntry {
  rel: string;
  size: number;
  mtime: number;
  refs: number;
}

/** 一个文件夹分组（与 filesApi.FolderTree 结构兼容） */
export interface FilesGroup {
  folder: string;
  files: FilesEntry[];
}

/** GET /files/refs 返回的单条引用（filesApi.FileRef 的传输形态） */
interface FileRefDetail {
  modelName: string;
  field: "gguf_file" | "mmproj_file";
}

/** POST /files/bulk-delete 返回的跳过项（filesApi.BulkDeleteResult 的传输形态） */
interface BulkSkipDetail {
  path: string;
  reason: "locked" | "referenced" | "notFound";
}

/** 表格行：文件数据 + 分片组推导结果（groupSize>1 表示处于一个分片组中） */
interface ShardRow extends FilesEntry {
  /** 文件名（rel 最后一段） */
  name: string;
  /** 该分片组的实际文件数（1 = 非分片或孤立分片），来自 buildShardIndex，
   * 与排序无关 */
  groupSize: number;
  /** 组内首行（挂徽标），按当前渲染顺序的相邻性算 */
  first: boolean;
  /** 组内末行（保留底边框），按当前渲染顺序的相邻性算 */
  last: boolean;
}

/**
 * 把（已按当前查询过滤/排序好的）文件列表推导成行：相邻且 shardIndex 里
 * key 相同的行归为同一段（决定连接线渲染），组内文件数一律从 shardIndex
 * 取（与本次排序/筛选无关，见文件顶部注释）。
 */
function buildRows(files: FilesEntry[], shardIndex: ReadonlyMap<string, ShardIndexEntry>): ShardRow[] {
  const keyed = files.map((f) => {
    const name = f.rel.includes("/") ? (f.rel.split("/").pop() as string) : f.rel;
    // shardIndex 由同一批文件（该命名空间全量）建出，这里的 f.rel 恒在索引里；
    // 找不到时按"非分片独立文件"兜底，不让一次意外的数据不一致炸整个表格
    const entry = shardIndex.get(f.rel) ?? { key: null, size: 1 };
    return { ...f, name, shardKey: entry.key, groupSize: entry.size };
  });

  const rows: ShardRow[] = [];
  for (let i = 0; i < keyed.length; ) {
    let j = i + 1;
    while (
      j < keyed.length &&
      keyed[i].shardKey !== null &&
      keyed[j].shardKey === keyed[i].shardKey
    ) {
      j++;
    }
    for (let k = i; k < j; k++) {
      rows.push({
        rel: keyed[k].rel,
        size: keyed[k].size,
        mtime: keyed[k].mtime,
        refs: keyed[k].refs,
        name: keyed[k].name,
        groupSize: keyed[k].groupSize,
        first: k === i,
        last: k === j - 1,
      });
    }
    i = j;
  }
  return rows;
}

/** 单行：勾选 / 文件（分片组标识）/ 大小 / 引用数 / 修改时间 / 操作菜单（移动/改名/删除，锁定禁用） */
function FileRow({
  row,
  locked,
  checking,
  error,
  selected,
  onToggleSelect,
  onOpenMove,
  onOpenRename,
  onCheckDelete,
}: {
  row: ShardRow;
  locked: ReadonlySet<string>;
  checking: string | null;
  error: string | null;
  selected: boolean;
  onToggleSelect: (rel: string, checked: boolean) => void;
  onOpenMove: (row: ShardRow) => void;
  onOpenRename: (row: ShardRow) => void;
  onCheckDelete: (row: ShardRow) => void;
}) {
  const t = useTranslations("pages.files");
  const isLocked = locked.has(row.rel);
  const inGroup = row.groupSize > 1;
  const mtime = new Date(row.mtime);

  return (
    <TableRow className={inGroup && !row.last ? "border-b-0" : undefined}>
      <TableCell className="w-8">
        <Checkbox
          aria-label={t("selectRow", { name: row.name })}
          checked={selected}
          onCheckedChange={(checked) => onToggleSelect(row.rel, checked === true)}
        />
      </TableCell>
      <TableCell>
        <div
          className={cn(
            "flex min-w-0 flex-col gap-0.5",
            inGroup && !row.first && "ml-1 border-l border-border/70 pl-2.5",
          )}
        >
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-mono text-[13px] font-semibold">{row.name}</span>
            {inGroup && row.first && (
              <Badge
                variant="outline"
                className="h-4.5 gap-1 px-1.5 font-sans text-[10px] leading-none text-muted-foreground"
              >
                <Layers className="size-2.5!" />
                {t("shardBadge", { count: row.groupSize })}
              </Badge>
            )}
            {isLocked && (
              <Badge
                variant="outline"
                title={t("lockedTooltip")}
                className="gap-1 border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
              >
                <Lock className="size-3!" />
                {t("lockedBadge")}
              </Badge>
            )}
          </div>
          <span className="truncate text-xs text-muted-foreground">{row.rel}</span>
        </div>
      </TableCell>
      <TableCell className="w-[90px] font-mono text-[13px] tabular-nums">
        {formatSize(row.size)}
      </TableCell>
      <TableCell className="w-[76px] font-mono text-[13px] tabular-nums">
        {row.refs > 0 ? t("refsCount", { count: row.refs }) : <span className="text-muted-foreground">—</span>}
      </TableCell>
      <TableCell className="w-[138px] font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums">
        {mtime.toLocaleString("sv-SE", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })}
      </TableCell>
      <TableCell className="w-[56px]">
        <div className="flex flex-col items-start gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={t("actionMore")}
              disabled={isLocked || checking !== null}
              title={isLocked ? t("lockedTooltip") : undefined}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
            >
              {checking === row.rel ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : isLocked ? (
                <Lock className="size-3.5" />
              ) : (
                <MoreHorizontal className="size-4" />
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-36">
              <DropdownMenuItem onClick={() => onOpenMove(row)}>
                <FolderInput />
                {t("actionMove")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onOpenRename(row)}>
                <Pencil />
                {t("actionRename")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onCheckDelete(row)}>
                <Trash2 />
                {t("actionDelete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {error && <p className="text-xs whitespace-normal text-destructive">{error}</p>}
        </div>
      </TableCell>
    </TableRow>
  );
}

export interface FilesTableProps {
  groups: FilesGroup[];
  /** 运行中模型引用的 relPath 集合（SSR 计算）：这些行的删除按钮直接禁用 */
  locked: ReadonlySet<string>;
  /** 全部磁盘文件夹（page 传入，供移动目标 Select；含文件当前所在文件夹，弹层里过滤掉） */
  folders: string[];
  /** 「全部文件」视图为 true：按文件夹插分组头行；选中具体文件夹时为
   * false，单表不分组（这一维已经交给左侧二级栏切片，组内再分是冗余） */
  groupByFolder: boolean;
}

/** 文件表：一张平表 + 上方 Toolbar（筛选 chip + 搜索 + 排序），底部三个 Dialog 不变 */
export function FilesTable({ groups, locked, folders, groupByFolder }: FilesTableProps) {
  const t = useTranslations("pages.files");
  const router = useRouter();
  const [checking, setChecking] = useState<string | null>(null);
  const [draft, setDraft] = useState<{
    rel: string;
    name: string;
    refs: FileRefDetail[];
    siblings: string[];
  } | null>(null);
  const [force, setForce] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  // 移动（T2）：目标文件夹待选，确认框展示引用清单 + 同组分片（整组移动）
  const [moveDraft, setMoveDraft] = useState<{
    rel: string;
    name: string;
    refs: FileRefDetail[];
    siblings: string[];
  } | null>(null);
  const [moveTarget, setMoveTarget] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);

  // 改名（T2）：分片组（prefix !== null）只能编辑前缀，序号段（suffix）灰显
  const [renameDraft, setRenameDraft] = useState<{
    rel: string;
    name: string;
    refs: FileRefDetail[];
    siblings: string[];
    prefix: string | null;
    suffix: string;
  } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  // 搜索 / 排序（U21）：applyFileQuery 纯函数按分组分别过滤+排序
  const [keyword, setKeyword] = useState("");
  const [sort, setSort] = useState<FileSortKey>("name");
  const [dir, setDir] = useState<FileSortDir>("asc");
  const query = useMemo<FileQuery>(() => ({ keyword, sort, dir }), [keyword, sort, dir]);

  // 筛选 chip（M16 T6）：选中态是表格自己的临时状态，不写进 URL——URL 的
  // ns 已经被二级栏占了，切走这个视图再回来，筛选重置是合理的
  const [activeChip, setActiveChip] = useState("all");

  // 多选批量删除（U21）
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  function setRowError(rel: string, message: string | null) {
    setRowErrors((prev) => {
      const next = { ...prev };
      if (message === null) delete next[rel];
      else next[rel] = message;
      return next;
    });
  }

  /** 拉取某文件当前引用清单 + 同组分片：删除/移动/改名三个确认框共用数据源 */
  type RefsFetchResult =
    | { kind: "network" }
    | { kind: "error" }
    | { kind: "ok"; refs: FileRefDetail[]; runningLocked: boolean; siblings: string[] };

  /** 拉取某文件当前引用清单 + 同组分片：删除/移动/改名三个确认框共用数据源
   *（区分网络失败与请求失败，保留三个入口原有的报错文案精度） */
  async function fetchRefs(rel: string): Promise<RefsFetchResult> {
    const res = await apiFetch(`/api/v1/files/refs?path=${encodeURIComponent(rel)}`).catch(() => null);
    if (res === null) return { kind: "network" };
    if (!res.ok) return { kind: "error" };
    const data = (await res.json().catch(() => null)) as {
      refs: FileRefDetail[];
      runningLocked: boolean;
      siblings: string[];
    } | null;
    if (data === null) return { kind: "error" };
    return { kind: "ok", refs: data.refs, runningLocked: data.runningLocked, siblings: data.siblings };
  }

  /** 行删除第一步：拉引用清单分派三态（locked 行内报错 / 其余进确认 Dialog） */
  async function onCheckDelete(row: ShardRow) {
    if (checking !== null) return;
    setChecking(row.rel);
    setRowError(row.rel, null);
    const result = await fetchRefs(row.rel);
    setChecking(null);

    if (result.kind === "network") {
      setRowError(row.rel, t("errorNetwork"));
      return;
    }
    if (result.kind === "error") {
      setRowError(row.rel, t("errorRequest"));
      return;
    }
    if (result.runningLocked) {
      // 页面加载后模型才启动的竞态：SSR 未禁用，这里兜底拒绝
      setRowError(row.rel, t("errorLocked"));
      return;
    }
    setForce(false);
    setDraft({ rel: row.rel, name: row.name, refs: result.refs, siblings: result.siblings });
  }

  /** 行移动第一步：同款拉引用清单，进移动确认框（目标命名空间待选，整组分片一并列出） */
  async function onOpenMove(row: ShardRow) {
    if (checking !== null) return;
    setChecking(row.rel);
    setRowError(row.rel, null);
    const result = await fetchRefs(row.rel);
    setChecking(null);

    if (result.kind === "network") {
      setRowError(row.rel, t("errorNetwork"));
      return;
    }
    if (result.kind === "error") {
      setRowError(row.rel, t("errorRequest"));
      return;
    }
    if (result.runningLocked) {
      setRowError(row.rel, t("errorLocked"));
      return;
    }
    setMoveTarget(null);
    setMoveError(null);
    setMoveDraft({ rel: row.rel, name: row.name, refs: result.refs, siblings: result.siblings });
  }

  /** 行改名第一步：分片组（shardGroup 命中）只暴露前缀可编辑，序号段照抄自身展示 */
  async function onOpenRename(row: ShardRow) {
    if (checking !== null) return;
    setChecking(row.rel);
    setRowError(row.rel, null);
    const result = await fetchRefs(row.rel);
    setChecking(null);

    if (result.kind === "network") {
      setRowError(row.rel, t("errorNetwork"));
      return;
    }
    if (result.kind === "error") {
      setRowError(row.rel, t("errorRequest"));
      return;
    }
    if (result.runningLocked) {
      setRowError(row.rel, t("errorLocked"));
      return;
    }
    const group = shardGroup(row.name);
    const prefix = group?.prefix ?? null;
    setRenameValue(prefix ?? row.name);
    setRenameError(null);
    setRenameDraft({
      rel: row.rel,
      name: row.name,
      refs: result.refs,
      siblings: result.siblings,
      prefix,
      suffix: prefix === null ? "" : row.name.slice(prefix.length),
    });
  }

  /** 移动/改名的错误响应走 `{ error: CODE }` 契约（与删除的消息文本不同），按 code 映射文案 */
  function guardErrorMessage(code: string | undefined): string {
    switch (code) {
      case "LOCKED":
        return t("errorLocked");
      case "NOT_FOUND":
        return t("errorNotFound");
      case "CONFLICT":
        return t("moveErrorConflict");
      case "INVALID_PATH":
        return t("moveErrorInvalid");
      // 文件已 mv、引用重写事务失败：重试无用（源文件已不在原处），
      // 必须让用户去核对配置而不是再点一次
      case "MOVE_PARTIAL":
        return t("errorMovePartial");
      default:
        return t("errorRequest");
    }
  }

  /** 确认移动：决策 9，总是同步全部引用，不提供勾选跳过 */
  async function onConfirmMove() {
    if (moveDraft === null || moveTarget === null || moving) return;
    setMoving(true);
    setMoveError(null);
    const res = await apiFetch("/api/v1/files/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: moveDraft.rel, toFolder: moveTarget }),
    }).catch(() => null);
    setMoving(false);

    if (res === null) {
      setMoveError(t("errorNetwork"));
      return;
    }
    if (res.ok) {
      setMoveDraft(null);
      router.refresh();
      toast.success(t("moveDone", { name: moveDraft.name }));
      return;
    }
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    setMoveError(guardErrorMessage(body?.error));
  }

  /** 确认改名：分片组场景 renameValue 是前缀（不含序号段），单文件是完整新文件名 */
  async function onConfirmRename() {
    if (renameDraft === null || renaming) return;
    const value = renameValue.trim();
    if (value === "") return;
    setRenaming(true);
    setRenameError(null);
    const res = await apiFetch("/api/v1/files/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: renameDraft.rel, newName: value }),
    }).catch(() => null);
    setRenaming(false);

    if (res === null) {
      setRenameError(t("errorNetwork"));
      return;
    }
    if (res.ok) {
      setRenameDraft(null);
      router.refresh();
      toast.success(t("renameDone", { name: renameDraft.name }));
      return;
    }
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    setRenameError(guardErrorMessage(body?.error));
  }

  /** 确认删除：force 仅在存在引用时随勾选传入；错误竞态落到行内 */
  async function onConfirmDelete() {
    if (draft === null || deleting) return;
    setDeleting(true);
    const res = await apiFetch("/api/v1/files", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: draft.rel,
        force: draft.refs.length > 0 && force,
      }),
    }).catch(() => null);
    setDeleting(false);

    if (res === null) {
      setRowError(draft.rel, t("errorNetwork"));
      setDraft(null);
      return;
    }
    if (res.ok) {
      setDraft(null);
      router.refresh();
      return;
    }
    setDraft(null);
    if (res.status === 409) setRowError(draft.rel, t("errorReferenced"));
    else if (res.status === 423) setRowError(draft.rel, t("errorLocked"));
    else if (res.status === 404) setRowError(draft.rel, t("errorNotFound"));
    else setRowError(draft.rel, t("errorRequest"));
  }

  function toggleRow(rel: string, checked: boolean): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(rel);
      else next.delete(rel);
      return next;
    });
  }

  function toggleGroup(rels: string[], checked: boolean): void {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const rel of rels) {
        if (checked) next.add(rel);
        else next.delete(rel);
      }
      return next;
    });
  }

  /** 批量删除确认：恒 force:true（对齐单文件"强制删除"语义），LOCKED 服务端仍不放行 */
  async function onConfirmBulkDelete(): Promise<void> {
    if (bulkDeleting || selected.size === 0) return;
    setBulkDeleting(true);
    const paths = [...selected];
    const res = await apiFetch("/api/v1/files/bulk-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths, force: true }),
    }).catch(() => null);
    setBulkDeleting(false);
    setBulkOpen(false);

    if (res === null) {
      toast.error(t("errorNetwork"));
      return;
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(body?.error ?? t("errorRequest"));
      return;
    }
    const data = (await res.json().catch(() => null)) as {
      deleted: string[];
      skipped: BulkSkipDetail[];
    } | null;

    setSelected(new Set());
    router.refresh();

    if (data === null) return;
    if (data.skipped.length > 0) {
      toast.info(t("bulkDeleteDoneWithSkipped", { deleted: data.deleted.length, skipped: data.skipped.length }));
    } else {
      toast.success(t("bulkDeleteDone", { count: data.deleted.length }));
    }
  }

  const locale = useLocale();
  const draftNames = useMemo(
    () => (draft === null ? [] : [...new Set(draft.refs.map((r) => r.modelName))]),
    [draft],
  );
  const nameList = useMemo(
    () => new Intl.ListFormat(locale).format(draftNames),
    [draftNames, locale],
  );

  const moveNames = useMemo(
    () => (moveDraft === null ? [] : [...new Set(moveDraft.refs.map((r) => r.modelName))]),
    [moveDraft],
  );
  const moveNameList = useMemo(
    () => new Intl.ListFormat(locale).format(moveNames),
    [moveNames, locale],
  );
  // 目标文件夹候选：排除文件当前所在文件夹（rel 首段，A6 起 planFileMove
  // 只接受磁盘上已存在的一级目录，folders 就是磁盘目录清单，无需再过滤别的）
  const moveCandidates = moveDraft === null ? [] : folders.filter((f) => f !== moveDraft.rel.split("/")[0]);

  const renameNames = useMemo(
    () => (renameDraft === null ? [] : [...new Set(renameDraft.refs.map((r) => r.modelName))]),
    [renameDraft],
  );
  const renameNameList = useMemo(
    () => new Intl.ListFormat(locale).format(renameNames),
    [renameNames, locale],
  );
  // 单文件必须保留 .gguf 后缀；分片组前缀不允许含 "/"（对齐服务端 planFileRename 的校验）
  const renameTrimmed = renameValue.trim();
  const renameInvalid =
    renameDraft !== null &&
    (renameTrimmed === "" ||
      renameTrimmed.includes("/") ||
      (renameDraft.prefix === null && !renameTrimmed.endsWith(".gguf")));

  // 分片索引（M16 T6）：从当前切片的全量文件建（与查询/排序/筛选无关），
  // rel 已含命名空间前缀，跨命名空间同名前缀天然不会串组
  const shardIndex = useMemo(() => buildShardIndex(groups.flatMap((g) => g.files)), [groups]);

  const chipDefs: { key: string; label: string; match: (f: FilesEntry) => boolean }[] = [
    { key: "all", label: t("chipAll"), match: () => true },
    { key: "shard", label: t("chipShard"), match: (f) => (shardIndex.get(f.rel)?.size ?? 1) > 1 },
    { key: "run", label: t("chipRunning"), match: (f) => locked.has(f.rel) },
    { key: "unref", label: t("chipUnref"), match: (f) => f.refs === 0 },
  ];

  // 关键字匹配 basename，与 file-list.ts 的 applyFileQuery 同一口径
  // （fileName 从那边导出复用，避免另写一份、筛出跟排序/搜索对不上的结果）
  function searchMatch(f: FilesEntry): boolean {
    const kw = query.keyword.trim().toLowerCase();
    return kw === "" || fileName(f.rel).toLowerCase().includes(kw);
  }

  const allFilesFlat = useMemo(() => groups.flatMap((g) => g.files), [groups]);
  const sliceTotal = allFilesFlat.length;

  // 计数必须喂当前切片的全量文件（经搜索收窄），不能喂已按 chip 过滤后的
  // 可见列表——否则除当前选中项外全部归零，把用户点回其它筛选的路焊死
  const counts = computeChipCounts(allFilesFlat, chipDefs, searchMatch);
  const activeMatch = chipDefs.find((c) => c.key === activeChip)?.match ?? (() => true);

  const grouped = useMemo(
    () =>
      groups
        .map((group) => ({
          group,
          rows: buildRows(applyFileQuery(group.files, query).filter(activeMatch), shardIndex),
        }))
        .filter((g) => g.rows.length > 0),
    // activeMatch 每次渲染都重新创建（闭包捕获 shardIndex/locked），用
    // activeChip 这个原始值做依赖更稳定，效果等价
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, query, activeChip, shardIndex],
  );

  const totalVisibleRows = grouped.reduce((sum, g) => sum + g.rows.length, 0);

  // 表头「全选/取消全选当前可见行」：拍平单表后不再区分命名空间，直接对
  // 当前可见的全部行生效（复用既有 toggleGroup，它本就不限定必须是"一个组"）
  const allVisibleRels = useMemo(() => grouped.flatMap((g) => g.rows.map((r) => r.rel)), [grouped]);
  const allVisibleSelected = allVisibleRels.length > 0 && allVisibleRels.every((rel) => selected.has(rel));
  const someVisibleSelected = allVisibleRels.some((rel) => selected.has(rel));

  const sizeByRel = useMemo(() => {
    const map = new Map<string, number>();
    for (const g of groups) for (const f of g.files) map.set(f.rel, f.size);
    return map;
  }, [groups]);

  const selectedBytes = useMemo(
    () => [...selected].reduce((sum, rel) => sum + (sizeByRel.get(rel) ?? 0), 0),
    [selected, sizeByRel],
  );
  const lockedSelectedCount = useMemo(
    () => [...selected].filter((rel) => locked.has(rel)).length,
    [selected, locked],
  );
  const deletableSelectedCount = selected.size - lockedSelectedCount;

  return (
    <div className="flex flex-col">
      <Toolbar
        chips={chipDefs.map((c) => ({ key: c.key, label: c.label, count: counts[c.key] }))}
        activeChip={activeChip}
        onChipChange={setActiveChip}
        // 分母取「全部」chip 的计数（counts.all），不是切片全量：两个数字
        // 挤在同一条 32px 的工具条里，搜索一激活就会变成「全部 10」旁边
        // 写着「/ 25」两个数打架，用户会两个都不信——有 chip 时分母必须
        // 跟"全部"这枚 chip 保持同一个值（对齐设计稿 applyFiles() 的
        // tbNote 用 counts.all，而不是全量 rows.length）
        note={{ shown: totalVisibleRows, total: counts.all }}
        search={{ value: keyword, onChange: setKeyword, placeholder: t("searchPlaceholder") }}
        action={
          <>
            <Select value={sort} onValueChange={(v) => setSort(v as FileSortKey)}>
              <SelectTrigger className="w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="name">{t("sortName")}</SelectItem>
                <SelectItem value="size">{t("sortSize")}</SelectItem>
                <SelectItem value="mtime">{t("sortMtime")}</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="icon"
              aria-label={dir === "asc" ? t("sortAsc") : t("sortDesc")}
              title={dir === "asc" ? t("sortAsc") : t("sortDesc")}
              onClick={() => setDir((d) => (d === "asc" ? "desc" : "asc"))}
            >
              {dir === "asc" ? <SortAsc className="size-4" /> : <SortDesc className="size-4" />}
            </Button>
          </>
        }
      />

      <div className="px-7 py-5">
        {/* 选中操作条（U21）：跨分组统计，批量删除入口 */}
        {selected.size > 0 && (
          <div className="mb-3.5 flex items-center justify-between rounded-lg border bg-muted/40 px-3 py-2">
            <span className="text-sm">
              {t("selectionBar", { count: selected.size, size: formatSize(selectedBytes) })}
            </span>
            <Button variant="destructive" size="sm" onClick={() => setBulkOpen(true)}>
              <Trash2 className="size-3.5" />
              {t("bulkDeleteButton")}
            </Button>
          </div>
        )}

        <Table className="min-w-[860px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <Checkbox
                  aria-label={t("selectAllVisible")}
                  checked={allVisibleSelected}
                  indeterminate={someVisibleSelected && !allVisibleSelected}
                  onCheckedChange={(checked) => toggleGroup(allVisibleRels, checked === true)}
                />
              </TableHead>
              <TableHead>{t("colFile")}</TableHead>
              <TableHead className="w-[90px]">{t("colSize")}</TableHead>
              <TableHead className="w-[76px]">{t("colRefs")}</TableHead>
              <TableHead className="w-[138px]">{t("colMtime")}</TableHead>
              <TableHead className="w-[56px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {grouped.map(({ group, rows }) => (
              <Fragment key={group.folder}>
                {groupByFolder && (
                  <TableRow className="bg-muted/30 hover:bg-muted/30">
                    <TableCell colSpan={6} className="py-2">
                      <div className="flex items-center gap-2.5">
                        <Folder className="size-3.5 text-muted-foreground" />
                        <span className="font-mono text-[12.5px] font-semibold">{group.folder}</span>
                        <span className="text-xs text-muted-foreground">
                          {t("groupMeta", { count: rows.length, size: formatSize(rows.reduce((sum, r) => sum + r.size, 0)) })}
                        </span>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
                {rows.map((row) => (
                  <FileRow
                    key={row.rel}
                    row={row}
                    locked={locked}
                    checking={checking}
                    error={rowErrors[row.rel] ?? null}
                    selected={selected.has(row.rel)}
                    onToggleSelect={toggleRow}
                    onOpenMove={onOpenMove}
                    onOpenRename={onOpenRename}
                    onCheckDelete={onCheckDelete}
                  />
                ))}
              </Fragment>
            ))}
            {totalVisibleRows === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="py-8 text-center text-xs text-muted-foreground">
                  {/* 切片本身为空与"筛掉了"是两回事：前者该去下载/移入文件，
                      后者该放宽条件，同一句话指不了两个方向 */}
                  {sliceTotal === 0 ? t("folderEmpty") : t("searchNoResults")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* 删除确认 Dialog（三态共用壳，内容按 refs 分派） */}
      <Dialog
        open={draft !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setDraft(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteTitle")}</DialogTitle>
            <DialogDescription>
              <span className="break-all font-mono text-xs">{draft?.rel}</span>
            </DialogDescription>
          </DialogHeader>

          {draft !== null && draft.refs.length > 0 ? (
            <div className="flex flex-col gap-2.5">
              <div
                role="alert"
                className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-sm text-amber-700 dark:text-amber-400"
              >
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span>{t("deleteReferencedWarning", { count: draftNames.length })}</span>
                  <span className="break-all font-mono text-xs">{nameList}</span>
                </div>
              </div>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={force}
                  onChange={(e) => setForce(e.target.checked)}
                  className="mt-0.5 size-3.5 shrink-0 accent-amber-600"
                />
                <span>{t("forceLabel")}</span>
              </label>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t("deleteSimpleDescription")}</p>
          )}

          {draft !== null && draft.siblings.length > 0 && (
            <p className="rounded-lg bg-muted/60 px-2.5 py-2 text-xs text-muted-foreground">
              {t("siblingsHint", { count: draft.siblings.length })}
            </p>
          )}

          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>{t("cancel")}</DialogClose>
            <Button
              variant="destructive"
              disabled={(draft === null) || (draft !== null && draft.refs.length > 0 && !force) || deleting}
              onClick={onConfirmDelete}
            >
              {deleting && <Loader2 className="animate-spin" />}
              {deleting
                ? t("deleting")
                : draft !== null && draft.refs.length > 0
                  ? t("confirmForceDelete")
                  : t("confirmDelete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 移动确认 Dialog（T2）：目标命名空间 Select + 引用清单展示，决策 9 无勾选跳过 */}
      <Dialog
        open={moveDraft !== null}
        onOpenChange={(open) => {
          if (!open && !moving) setMoveDraft(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("moveTitle")}</DialogTitle>
            <DialogDescription>
              <span className="break-all font-mono text-xs">{moveDraft?.rel}</span>
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">{t("moveTargetLabel")}</span>
              <Select value={moveTarget} onValueChange={(v) => setMoveTarget(v === null ? null : String(v))}>
                <SelectTrigger className="w-full font-mono">
                  <SelectValue placeholder={t("moveTargetPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {moveCandidates.map((f) => (
                    <SelectItem key={f} value={f}>
                      {f}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {moveDraft !== null && moveDraft.refs.length > 0 && (
              <div
                role="alert"
                className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-sm text-amber-700 dark:text-amber-400"
              >
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span>{t("moveReferencedWarning", { count: moveNames.length })}</span>
                  <span className="break-all font-mono text-xs">{moveNameList}</span>
                </div>
              </div>
            )}

            {moveDraft !== null && moveDraft.siblings.length > 0 && (
              <p className="rounded-lg bg-muted/60 px-2.5 py-2 text-xs text-muted-foreground">
                {t("moveGroupHint", { count: moveDraft.siblings.length + 1 })}
              </p>
            )}

            {moveError && <p className="text-xs text-destructive">{moveError}</p>}
          </div>

          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={moving} />}>{t("cancel")}</DialogClose>
            <Button disabled={moveTarget === null || moving} onClick={onConfirmMove}>
              {moving && <Loader2 className="animate-spin" />}
              {moving ? t("moving") : t("confirmMove")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 改名确认 Dialog（T2）：分片组只暴露前缀可编辑，序号段灰显（决策 7） */}
      <Dialog
        open={renameDraft !== null}
        onOpenChange={(open) => {
          if (!open && !renaming) setRenameDraft(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("renameTitle")}</DialogTitle>
            <DialogDescription>
              <span className="break-all font-mono text-xs">{renameDraft?.rel}</span>
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                {renameDraft?.prefix === null ? t("renameNameLabel") : t("renamePrefixLabel")}
              </span>
              <div className="flex items-center gap-1">
                <Input
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  className="font-mono"
                  aria-invalid={renameInvalid}
                />
                {renameDraft !== null && renameDraft.prefix !== null && (
                  <span className="shrink-0 font-mono text-sm text-muted-foreground">{renameDraft.suffix}</span>
                )}
              </div>
              {renameDraft !== null && renameDraft.prefix !== null && (
                <p className="text-xs text-muted-foreground">{t("renameSuffixHint")}</p>
              )}
            </div>

            {renameDraft !== null && renameDraft.refs.length > 0 && (
              <div
                role="alert"
                className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-sm text-amber-700 dark:text-amber-400"
              >
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span>{t("renameReferencedWarning", { count: renameNames.length })}</span>
                  <span className="break-all font-mono text-xs">{renameNameList}</span>
                </div>
              </div>
            )}

            {renameDraft !== null && renameDraft.siblings.length > 0 && (
              <p className="rounded-lg bg-muted/60 px-2.5 py-2 text-xs text-muted-foreground">
                {t("moveGroupHint", { count: renameDraft.siblings.length + 1 })}
              </p>
            )}

            {renameError && <p className="text-xs text-destructive">{renameError}</p>}
          </div>

          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={renaming} />}>{t("cancel")}</DialogClose>
            <Button disabled={renameInvalid || renaming} onClick={onConfirmRename}>
              {renaming && <Loader2 className="animate-spin" />}
              {renaming ? t("renaming") : t("confirmRename")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 批量删除确认 Dialog（U21）：locked 集合已是 SSR prop，直接算 N/M 无需再拉 refs */}
      <Dialog
        open={bulkOpen}
        onOpenChange={(open) => {
          if (!open && !bulkDeleting) setBulkOpen(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("bulkDeleteTitle")}</DialogTitle>
            <DialogDescription>
              {lockedSelectedCount > 0
                ? t("bulkDeleteSummary", { deletable: deletableSelectedCount, locked: lockedSelectedCount })
                : t("bulkDeleteSimpleDescription", { count: selected.size })}
            </DialogDescription>
          </DialogHeader>

          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>{t("cancel")}</DialogClose>
            <Button variant="destructive" disabled={bulkDeleting} onClick={onConfirmBulkDelete}>
              {bulkDeleting && <Loader2 className="animate-spin" />}
              {bulkDeleting ? t("deleting") : t("bulkDeleteButton")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
