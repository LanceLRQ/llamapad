"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Folder, FolderPlus, Loader2, Pencil, Trash2 } from "lucide-react";

import { formatSize } from "@/lib/format";
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
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * 设置页「命名空间」区块（M1 Task 12，client）：接收 server 侧装配好的
 * listOverview 数据，渲染列表 + 新建 / 重命名 / 删除三类操作，动作完成后
 * router.refresh() 重取 page 数据（实时性策略与模型列表一致：动作触发刷新）。
 *
 * 语义透出（与服务层一致）：
 * - 新建仅建 DB 记录（目录惰性创建）
 * - 重命名弹 Dialog：磁盘目录与该空间全部模型配置一并迁移
 * - 删除：modelCount > 0 时按钮禁用 + 提示（服务端同款守卫兜底）；
 *   确认弹 Dialog（只删记录，磁盘留给文件页）
 */

/** 一行命名空间数据（与 namespaces.NamespaceOverview 结构兼容，客户端不引 server 模块） */
export interface NamespaceEntry {
  name: string;
  createdAt: string;
  modelCount: number;
  bytes: number;
}

/** createdAt → 本地化日期时间（与文件页修改时间同款格式） */
function formatCreatedAt(locale: string, iso: string): string {
  return new Date(iso).toLocaleString("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function NamespacesCard({ namespaces }: { namespaces: NamespaceEntry[] }) {
  const t = useTranslations("pages.settings");
  const locale = useLocale();
  const router = useRouter();

  const [draftName, setDraftName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [renaming, setRenaming] = useState<NamespaceEntry | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  const [deleting, setDeleting] = useState<NamespaceEntry | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  /** 统一的错误文案：按状态码映射（服务端守卫为最终裁决） */
  function messageFor(status: number, fallback: string): string {
    if (status === 409) return t("errorConflict");
    if (status === 404) return t("errorNotFound");
    return fallback;
  }

  async function onCreate() {
    const name = draftName.trim();
    if (name === "" || creating) return;
    setCreating(true);
    setCreateError(null);
    const res = await fetch("/api/v1/namespaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }).catch(() => null);
    setCreating(false);

    if (res === null) {
      setCreateError(t("errorNetwork"));
      return;
    }
    if (res.ok) {
      setDraftName("");
      router.refresh();
      return;
    }
    if (res.status === 409) setCreateError(t("createErrorDuplicate"));
    else if (res.status === 400) setCreateError(t("createErrorInvalid"));
    else setCreateError(t("errorRequest"));
  }

  function openRename(entry: NamespaceEntry) {
    setRenameValue(entry.name);
    setRenameError(null);
    setRenaming(entry);
  }

  async function onConfirmRename() {
    if (renaming === null || renameBusy) return;
    const name = renameValue.trim();
    if (name === "" || name === renaming.name) return;
    setRenameBusy(true);
    setRenameError(null);
    const res = await fetch(`/api/v1/namespaces/${encodeURIComponent(renaming.name)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }).catch(() => null);
    setRenameBusy(false);

    if (res === null) {
      setRenameError(t("errorNetwork"));
      return;
    }
    if (res.ok) {
      setRenaming(null);
      router.refresh();
      return;
    }
    setRenameError(messageFor(res.status, t("errorRequest")));
  }

  async function onConfirmDelete() {
    if (deleting === null || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError(null);
    const res = await fetch(`/api/v1/namespaces/${encodeURIComponent(deleting.name)}`, {
      method: "DELETE",
    }).catch(() => null);
    setDeleteBusy(false);

    if (res === null) {
      setDeleteError(t("errorNetwork"));
      return;
    }
    if (res.ok) {
      setDeleting(null);
      router.refresh();
      return;
    }
    setDeleteError(messageFor(res.status, t("errorRequest")));
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2.5 border-b px-4 py-3">
        <Folder className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{t("nsTitle")}</h2>
        <span className="text-xs text-muted-foreground">{t("nsDescription")}</span>
      </div>

      <div className="flex flex-col gap-3 px-4 py-3.5">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("nsColName")}</TableHead>
              <TableHead className="w-[110px]">{t("nsColModels")}</TableHead>
              <TableHead className="w-[110px]">{t("nsColBytes")}</TableHead>
              <TableHead className="w-[150px]">{t("nsColCreated")}</TableHead>
              <TableHead className="w-[90px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {namespaces.map((entry) => {
              const blocked = entry.modelCount > 0;
              return (
                <TableRow key={entry.name}>
                  <TableCell className="font-mono text-[13px] font-semibold">
                    {entry.name}
                  </TableCell>
                  <TableCell className="font-mono text-[13px] tabular-nums">
                    {entry.modelCount > 0 ? (
                      t("nsModelsCount", { count: entry.modelCount })
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-[13px] tabular-nums">
                    {entry.bytes > 0 ? formatSize(entry.bytes) : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                    {formatCreatedAt(locale, entry.createdAt)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        title={t("nsRenameButton")}
                        disabled={renaming !== null || deleting !== null}
                        onClick={() => openRename(entry)}
                      >
                        <Pencil className="size-3.5" />
                        {t("nsRenameButton")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        title={blocked ? t("nsDeleteBlockedHint", { count: entry.modelCount }) : t("nsDeleteButton")}
                        disabled={blocked || renaming !== null || deleting !== null}
                        onClick={() => {
                          setDeleteError(null);
                          setDeleting(entry);
                        }}
                      >
                        <Trash2 className="size-3.5" />
                        {t("nsDeleteButton")}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>

        {/* 新建行 */}
        <div className="flex flex-col gap-1.5">
          <div className="flex max-w-md items-center gap-2">
            <Input
              className="font-mono"
              placeholder={t("nsCreatePlaceholder")}
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              aria-invalid={createError !== undefined}
              onKeyDown={(e) => {
                if (e.key === "Enter") onCreate();
              }}
            />
            <Button size="sm" disabled={draftName.trim() === "" || creating} onClick={onCreate}>
              {creating ? <Loader2 className="size-3.5 animate-spin" /> : <FolderPlus className="size-3.5" />}
              {creating ? t("nsCreating") : t("nsCreateButton")}
            </Button>
          </div>
          {createError && <p className="text-xs text-destructive">{createError}</p>}
        </div>
      </div>

      {/* 重命名 Dialog */}
      <Dialog
        open={renaming !== null}
        onOpenChange={(open) => {
          if (!open && !renameBusy) setRenaming(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("nsRenameTitle")}</DialogTitle>
            <DialogDescription>{t("nsRenameDescription")}</DialogDescription>
          </DialogHeader>
          <Input
            className="font-mono"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            aria-invalid={renameError !== undefined}
          />
          {renameError && <p className="text-xs text-destructive">{renameError}</p>}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={renameBusy} />}>
              {t("cancel")}
            </DialogClose>
            <Button
              disabled={renameBusy || renameValue.trim() === "" || renameValue.trim() === renaming?.name}
              onClick={onConfirmRename}
            >
              {renameBusy && <Loader2 className="animate-spin" />}
              {renameBusy ? t("nsRenaming") : t("nsRenameConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 Dialog */}
      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) setDeleting(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("nsDeleteTitle")}</DialogTitle>
            <DialogDescription>
              <span className="break-all font-mono text-xs">{deleting?.name}</span>
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{t("nsDeleteDescription")}</p>
          {deleteError && <p className="text-xs text-destructive">{deleteError}</p>}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={deleteBusy} />}>
              {t("cancel")}
            </DialogClose>
            <Button variant="destructive" disabled={deleteBusy} onClick={onConfirmDelete}>
              {deleteBusy && <Loader2 className="animate-spin" />}
              {deleteBusy ? t("nsDeleting") : t("nsDeleteConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
