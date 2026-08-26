"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Folder, Layers, Loader2, Lock, Search, SortAsc, SortDesc, Trash2, TriangleAlert } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { shardGroup } from "@/core/files";
import { applyFileQuery, type FileQuery, type FileSortDir, type FileSortKey } from "@/lib/file-list";
import { formatSize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
 * 文件浏览交互组件（M1 Task 11，U21 加搜索/排序/批量删除）：接收 server 侧
 * 装配好的 getFilesTree 分组数据 + 运行中模型锁定的文件集合，按命名空间
 * 分组建表。
 *
 * 分片成组：scanTree 按 rel 排序，同组（shardGroup 前缀 + total 相同）
 * 的分片天然相邻——首行挂「分片组 ×N」徽标，后续行缩进 + 左侧连接线、
 * 组内行间去边框，形成一段视觉上的组。搜索/排序（applyFileQuery）作用于
 * 每个分组内部：按 name 排序时原本的相邻关系保留，分片徽标照常；按
 * size/mtime 排序会打散相邻关系，分片徽标可能不再连续出现——可接受的
 * 视觉退化，不影响删除功能本身。
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
 * 批量删除：勾选跨分组的行（分组头 checkbox 支持组内全选/取消，
 * 三态用 indeterminate 表示部分选中），浮出操作条统计已选数量与总大小。
 * locked 集合已是 SSR 传入的既有 prop，无需逐个文件再拉 refs——确认框
 * 直接用 selected ∩ locked 算出「M 个将被跳过」。批量请求恒带
 * force:true（对齐单文件流程里"确认强制删除"的语义），但 LOCKED 在
 * 服务端无论 force 都不放行（风险簿第 8 条），所以锁定项即使勾选也只会
 * 被服务端跳过，不会误删。
 */

/** 一行文件数据（与 filesApi.TreeFile 结构兼容，客户端不引 server 模块） */
export interface FilesEntry {
  rel: string;
  size: number;
  mtime: number;
  refs: number;
}

/** 一个命名空间分组（与 filesApi.NamespaceTree 结构兼容） */
export interface FilesGroup {
  namespace: string;
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
  /** 相邻同组行数（1 = 非分片或孤立分片） */
  groupSize: number;
  /** 组内首行（挂徽标） */
  first: boolean;
  /** 组内末行（保留底边框） */
  last: boolean;
}

/**
 * 把组内文件列表推导成行：相邻且 shardGroup 键（目录|前缀|total）相同的
 * 行归为同一分片组。非分片命名（shardGroup 为 null）各自成组。
 */
function buildRows(files: FilesEntry[]): ShardRow[] {
  const keyed = files.map((f) => {
    const name = f.rel.includes("/") ? (f.rel.split("/").pop() as string) : f.rel;
    const g = shardGroup(name);
    return {
      ...f,
      name,
      shardKey: g === null ? null : `${f.rel.slice(0, f.rel.length - name.length)}|${g.prefix}|${g.total}`,
    };
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
        groupSize: j - i,
        first: k === i,
        last: k === j - 1,
      });
    }
    i = j;
  }
  return rows;
}

/** 单行：勾选 / 文件（分片组标识）/ 大小 / 引用数 / 修改时间 / 删除（锁定禁用） */
function FileRow({
  row,
  locked,
  checking,
  error,
  selected,
  onToggleSelect,
  onCheckDelete,
}: {
  row: ShardRow;
  locked: ReadonlySet<string>;
  checking: string | null;
  error: string | null;
  selected: boolean;
  onToggleSelect: (rel: string, checked: boolean) => void;
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
      <TableCell className="w-[100px] font-mono text-[13px] tabular-nums">
        {row.refs > 0 ? t("refsCount", { count: row.refs }) : <span className="text-muted-foreground">—</span>}
      </TableCell>
      <TableCell className="w-[150px] font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums">
        {mtime.toLocaleString("sv-SE", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })}
      </TableCell>
      <TableCell className="w-[150px]">
        <div className="flex flex-col items-start gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={isLocked || checking !== null}
            title={isLocked ? t("lockedTooltip") : undefined}
            onClick={() => onCheckDelete(row)}
          >
            {checking === row.rel ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : isLocked ? (
              <Lock className="size-3.5" />
            ) : (
              <Trash2 className="size-3.5" />
            )}
            {t("actionDelete")}
          </Button>
          {error && <p className="text-xs whitespace-normal text-destructive">{error}</p>}
        </div>
      </TableCell>
    </TableRow>
  );
}

/** 文件表：按命名空间分组建 Card（分组头 = 图标 + ns + 文件数 + 占用），底部路径映射脚注 */
export function FilesTable({
  groups,
  locked,
  rootPanel,
  rootHost,
}: {
  groups: FilesGroup[];
  /** 运行中模型引用的 relPath 集合（SSR 计算）：这些行的删除按钮直接禁用 */
  locked: ReadonlySet<string>;
  /** panel.yaml 的 models 根（panel / host 两个视角，脚注展示） */
  rootPanel: string;
  rootHost: string;
}) {
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

  // 搜索 / 排序（U21）：applyFileQuery 纯函数按分组分别过滤+排序
  const [keyword, setKeyword] = useState("");
  const [sort, setSort] = useState<FileSortKey>("name");
  const [dir, setDir] = useState<FileSortDir>("asc");
  const query = useMemo<FileQuery>(() => ({ keyword, sort, dir }), [keyword, sort, dir]);

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

  /** 行删除第一步：拉引用清单分派三态（locked 行内报错 / 其余进确认 Dialog） */
  async function onCheckDelete(row: ShardRow) {
    if (checking !== null) return;
    setChecking(row.rel);
    setRowError(row.rel, null);
    const res = await apiFetch(
      `/api/v1/files/refs?path=${encodeURIComponent(row.rel)}`,
    ).catch(() => null);
    setChecking(null);

    if (res === null) {
      setRowError(row.rel, t("errorNetwork"));
      return;
    }
    if (!res.ok) {
      setRowError(row.rel, t("errorRequest"));
      return;
    }
    const data = (await res.json().catch(() => null)) as {
      refs: FileRefDetail[];
      runningLocked: boolean;
      siblings: string[];
    } | null;
    if (data === null) {
      setRowError(row.rel, t("errorRequest"));
      return;
    }
    if (data.runningLocked) {
      // 页面加载后模型才启动的竞态：SSR 未禁用，这里兜底拒绝
      setRowError(row.rel, t("errorLocked"));
      return;
    }
    setForce(false);
    setDraft({ rel: row.rel, name: row.name, refs: data.refs, siblings: data.siblings });
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

  const grouped = useMemo(
    () =>
      groups
        .map((g) => ({ group: g, rows: buildRows(applyFileQuery(g.files, query)) }))
        .filter((g) => g.rows.length > 0),
    [groups, query],
  );

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

  const searchedButEmpty = groups.some((g) => g.files.length > 0) && grouped.length === 0;

  return (
    <div className="flex flex-col gap-3.5">
      {/* 搜索 + 排序（U21） */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="pl-8"
          />
        </div>
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
      </div>

      {/* 选中操作条（U21）：跨分组统计，批量删除入口 */}
      {selected.size > 0 && (
        <div className="flex items-center justify-between rounded-lg border bg-muted/40 px-3 py-2">
          <span className="text-sm">
            {t("selectionBar", { count: selected.size, size: formatSize(selectedBytes) })}
          </span>
          <Button variant="destructive" size="sm" onClick={() => setBulkOpen(true)}>
            <Trash2 className="size-3.5" />
            {t("bulkDeleteButton")}
          </Button>
        </div>
      )}

      {searchedButEmpty && (
        <Card>
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t("searchNoResults")}</p>
        </Card>
      )}

      {grouped.map(({ group, rows }) => {
        const usedBytes = rows.reduce((sum, r) => sum + r.size, 0);
        const groupRels = rows.map((r) => r.rel);
        const selectedInGroup = groupRels.filter((rel) => selected.has(rel)).length;
        const groupAllSelected = groupRels.length > 0 && selectedInGroup === groupRels.length;
        const groupIndeterminate = selectedInGroup > 0 && !groupAllSelected;

        return (
          <Card key={group.namespace} className="gap-0 py-0">
            <div className="flex items-center gap-2.5 border-b px-4 py-3">
              <Folder className="size-4 text-muted-foreground" />
              <span className="font-mono text-sm font-semibold">{group.namespace}</span>
              <span className="text-xs text-muted-foreground">
                {t("groupMeta", { count: rows.length, size: formatSize(usedBytes) })}
              </span>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <Checkbox
                      aria-label={t("selectGroup", { namespace: group.namespace })}
                      checked={groupAllSelected}
                      indeterminate={groupIndeterminate}
                      onCheckedChange={(checked) => toggleGroup(groupRels, checked === true)}
                    />
                  </TableHead>
                  <TableHead>{t("colFile")}</TableHead>
                  <TableHead className="w-[90px]">{t("colSize")}</TableHead>
                  <TableHead className="w-[100px]">{t("colRefs")}</TableHead>
                  <TableHead className="w-[150px]">{t("colMtime")}</TableHead>
                  <TableHead className="w-[150px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <FileRow
                    key={row.rel}
                    row={row}
                    locked={locked}
                    checking={checking}
                    error={rowErrors[row.rel] ?? null}
                    selected={selected.has(row.rel)}
                    onToggleSelect={toggleRow}
                    onCheckDelete={onCheckDelete}
                  />
                ))}
              </TableBody>
            </Table>
          </Card>
        );
      })}

      <p className="mt-1 text-xs text-muted-foreground">
        {t("rootHint", { panel: rootPanel, host: rootHost })}
      </p>

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
