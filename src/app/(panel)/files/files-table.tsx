"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Folder, Layers, Loader2, Lock, Trash2, TriangleAlert } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { shardGroup } from "@/core/files";
import { formatSize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiFetch } from "@/lib/api";

/**
 * 文件浏览交互组件（M1 Task 11）：接收 server 侧装配好的
 * getFilesTree 分组数据 + 运行中模型锁定的文件集合，按命名空间分组建表。
 *
 * 分片成组：scanTree 按 rel 排序，同组（shardGroup 前缀 + total 相同）
 * 的分片天然相邻——首行挂「分片组 ×N」徽标，后续行缩进 + 左侧连接线、
 * 组内行间去边框，形成一段视觉上的组。
 *
 * 三态删除（点击先 GET /files/refs 再分派，服务端为最终裁决）：
 * - locked：SSR 已知（页面传入 locked 集合）按钮直接禁用 + 锁徽标；
 *   页面加载后模型才启动的竞态 → 拉 refs 发现 runningLocked，行内报错
 * - refs>0：确认 Dialog 列出引用配置 + 强制删除 checkbox（未勾选禁用确认）
 *   + 同组分片提示（siblings，只提示不自动删组）
 * - refs=0：简单确认 Dialog
 * 确认后 DELETE /api/v1/files { path, force } → router.refresh()；
 * 409/423/404 竞态错误显示在行内。
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

/** 单行：文件（分片组标识）/ 大小 / 引用数 / 修改时间 / 删除（锁定禁用） */
function FileRow({
  row,
  locked,
  checking,
  error,
  onCheckDelete,
}: {
  row: ShardRow;
  locked: ReadonlySet<string>;
  checking: string | null;
  error: string | null;
  onCheckDelete: (row: ShardRow) => void;
}) {
  const t = useTranslations("pages.files");
  const isLocked = locked.has(row.rel);
  const inGroup = row.groupSize > 1;
  const mtime = new Date(row.mtime);

  return (
    <TableRow className={inGroup && !row.last ? "border-b-0" : undefined}>
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

  const locale = useLocale();
  const draftNames = useMemo(
    () => (draft === null ? [] : [...new Set(draft.refs.map((r) => r.modelName))]),
    [draft],
  );
  const nameList = useMemo(
    () => new Intl.ListFormat(locale).format(draftNames),
    [draftNames, locale],
  );

  const grouped = useMemo(() => groups.map((g) => ({ group: g, rows: buildRows(g.files) })), [
    groups,
  ]);

  return (
    <div className="flex flex-col gap-3.5">
      {grouped.map(({ group, rows }) => {
        const usedBytes = rows.reduce((sum, r) => sum + r.size, 0);
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
    </div>
  );
}
