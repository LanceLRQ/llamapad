"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { FolderInput, Loader2, Trash2 } from "lucide-react";

import { CreateFolderDialog } from "@/components/create-folder-dialog";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiFetch } from "@/lib/api";
import { formatSize } from "@/lib/format";
import { fromSelectValue, ROOT_DIR_OPTION, toSelectValue, withRootFolder } from "@/lib/wizard-target-dir";
import type { RepoProfileSummary } from "./repo-detail-view";

/**
 * 档案详情页页头的两个弹层（任务 9 复核 D4 从 repo-detail-view.tsx 拆出）：
 * 都是自包含组件（内部持有 open state + 自己渲染触发按钮，见各自函数头
 * 注释），不需要外部 open/onOpenChange 受控，拆出来除了瘦身主文件，也让
 * 「详情页整体布局/数据流」与「两个弹层各自的交互细节」各自独立成一块、
 * 分开好读。只 `import type { RepoProfileSummary } from "./repo-detail-view"`——纯类型
 * 引用，编译期会被整个擦除，与 repo-detail-view.tsx 反向 import 本文件的
 * 两个组件不构成真正的运行时循环依赖。
 */

/** 「换存放位置」弹层：目标选择器复用向导「存放位置」同一套下拉（Select +
 *  根目录哨兵 + 新建文件夹），换的是 baseDir 而不是 targetDir——档案的
 *  targetDir 由 repoTargetDir(baseDir, repo) 派生，这里只需要选 baseDir。 */
export function MoveDialog({
  profile,
  onMoved,
}: {
  profile: RepoProfileSummary;
  onMoved: () => void;
}) {
  const t = useTranslations("pages.repos.moveDialog");
  const tc = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [folders, setFolders] = useState<string[]>([]);
  const [target, setTarget] = useState(profile.baseDir);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 重置 + 拉目录清单放在 onOpenChange 里而不是"open 变化"的 effect：两者
  // 都会调用 setState，effect 里做会撞 react-hooks/set-state-in-effect
  // （在 effect 同步执行期间触发 setState）——onOpenChange 是用户交互触发的
  // 普通回调，不受这条限制，与 files/folder-rename-dialog.tsx 同款做法
  function onOpenChange(next: boolean): void {
    if (busy) return;
    if (next) {
      setTarget(profile.baseDir);
      setError(null);
      apiFetch("/api/v1/folders", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { folders: string[] } | null) => {
          if (d) setFolders(d.folders);
        })
        .catch(() => {});
    }
    setOpen(next);
  }

  function handleFolderCreated(path: string): void {
    setFolders((prev) => (prev.includes(path) ? prev : [...prev, path].sort()));
    setTarget(path);
  }

  async function onConfirm(): Promise<void> {
    if (busy || target === profile.baseDir) return;
    setBusy(true);
    setError(null);
    const res = await apiFetch(`/api/v1/repos/${profile.id}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toBaseDir: target }),
    }).catch(() => null);
    setBusy(false);

    if (res === null) {
      setError(t("errorNetwork"));
      return;
    }
    if (res.ok) {
      setOpen(false);
      onMoved();
      return;
    }
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    switch (body?.error) {
      case "NOT_FOUND":
        setError(t("errorNotFound"));
        break;
      case "LOCKED":
        setError(t("errorLocked"));
        break;
      case "CONFLICT":
        setError(t("errorConflict"));
        break;
      case "INVALID_NAME":
      case "invalid_body":
        setError(t("errorInvalid"));
        break;
      case "MOVE_PARTIAL":
        setError(t("errorMovePartial"));
        break;
      default:
        setError(t("errorRequest"));
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => onOpenChange(true)}>
        <FolderInput className="size-3.5" />
        {t("title")}
      </Button>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>
              {t("description", {
                repo: profile.repo,
                baseDir: profile.baseDir === "" ? tc("filePicker.rootGroupLabel") : profile.baseDir,
              })}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t("targetLabel")}</span>
            <div className="flex gap-2">
              <Select value={toSelectValue(target)} onValueChange={(v) => setTarget(fromSelectValue(String(v)))}>
                <SelectTrigger className="w-full font-mono">
                  <SelectValue placeholder={t("targetPlaceholder")}>
                    {(v: string) => (v === ROOT_DIR_OPTION ? tc("filePicker.rootGroupLabel") : v)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {withRootFolder(folders).map((dir) => (
                    <SelectItem key={toSelectValue(dir)} value={toSelectValue(dir)}>
                      {dir === "" ? tc("filePicker.rootGroupLabel") : dir}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <CreateFolderDialog parentPath={target} onCreated={handleFolderCreated} />
            </div>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={busy} />}>{t("cancel")}</DialogClose>
            <Button disabled={busy || target === profile.baseDir} onClick={() => void onConfirm()}>
              {busy && <Loader2 className="animate-spin" />}
              {busy ? t("moving") : t("confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** 「删除档案」弹层：三层语义见 server/repoProfiles.ts deleteProfile 头注释，
 *  这里只管交互——默认不勾选（保留磁盘文件），勾上才显示占用大小与不可
 *  恢复提示；423（配置引用/未完成任务）把服务端 message 原样亮出来，
 *  那是动态内容（具体配置名），没法预先写进 i18n。 */
export function DeleteDialog({
  profile,
  occupiedBytes,
  onDeleted,
}: {
  profile: RepoProfileSummary;
  occupiedBytes: number;
  onDeleted: () => void;
}) {
  const t = useTranslations("pages.repos.deleteDialog");
  const [open, setOpen] = useState(false);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleOpenChange(next: boolean): void {
    if (busy) return;
    if (next) {
      setDeleteFiles(false);
      setError(null);
    }
    setOpen(next);
  }

  async function onConfirm(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await apiFetch(`/api/v1/repos/${profile.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deleteFiles }),
    }).catch(() => null);
    setBusy(false);

    if (res === null) {
      setError(t("errorNetwork"));
      return;
    }
    if (res.ok) {
      onDeleted();
      return;
    }
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    if (res.status === 423) {
      // 服务端 message 习惯带 "CODE: " 前缀（见 repoProfiles.ts），展示给
      // 用户时去掉，只留下真正有信息量的部分（列出的配置名/未完成任务数）
      setError((body?.message ?? t("errorRequest")).replace(/^[A-Z_]+:\s*/, ""));
    } else if (res.status === 404) {
      setError(t("errorNotFound"));
    } else {
      setError(t("errorRequest"));
    }
  }

  return (
    <>
      <Button variant="destructive" size="sm" onClick={() => handleOpenChange(true)}>
        <Trash2 className="size-3.5" />
        {t("title")}
      </Button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>{t("description", { repo: profile.repo })}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2.5">
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={deleteFiles}
                onCheckedChange={(checked) => setDeleteFiles(checked === true)}
                className="mt-0.5"
              />
              <span>{t("deleteFilesLabel")}</span>
            </label>
            <p className="rounded-lg bg-muted/60 px-2.5 py-2 text-xs text-muted-foreground">
              {deleteFiles ? t("deleteFilesHint", { size: formatSize(occupiedBytes) }) : t("keepFilesHint")}
            </p>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>

          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={busy} />}>{t("cancel")}</DialogClose>
            <Button variant="destructive" disabled={busy} onClick={() => void onConfirm()}>
              {busy && <Loader2 className="animate-spin" />}
              {busy ? t("deleting") : t("confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
