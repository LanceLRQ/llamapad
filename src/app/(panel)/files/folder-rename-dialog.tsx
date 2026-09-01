"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
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
import { apiFetch } from "@/lib/api";

/**
 * 「重命名文件夹」入口（阶段 1b B2）：B1 拿掉 renameNamespace 的 mv 之后，
 * 用户失去了重命名磁盘目录的能力，这个入口把它补回来——放在文件页而不是
 * 设置页的命名空间卡片，因为文件夹从阶段 1b 起是纯磁盘概念，与命名空间
 * 彻底无关（见 server/folders.ts 顶部注释）。
 *
 * 只在查看某个具体文件夹时出现（page.tsx 按 view.kind === "folder" 挂载），
 * affectedModelCount 由 page.tsx 用 buildRefMap 算好传入——避免打开 Dialog
 * 之前先转一次 GET 请求（数据本来就在 SSR 阶段可以顺手算出）。
 */
export function FolderRenameDialog({
  folder,
  affectedModelCount,
}: {
  folder: string;
  affectedModelCount: number;
}) {
  const t = useTranslations("pages.files");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(folder);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onOpenChange(next: boolean) {
    if (busy) return;
    if (next) {
      setValue(folder);
      setError(null);
    }
    setOpen(next);
  }

  async function onConfirm() {
    const name = value.trim();
    if (name === "" || name === folder || busy) return;
    setBusy(true);
    setError(null);
    const res = await apiFetch("/api/v1/folders/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: folder, to: name }),
    }).catch(() => null);
    setBusy(false);

    if (res === null) {
      setError(t("errorNetwork"));
      return;
    }
    if (res.ok) {
      setOpen(false);
      // 改名后旧的 ?path=folder 已经失效，直接导到新文件夹——不能只
      // router.refresh()，那样 URL 还指着一个刚消失的目录
      router.push(`/files?path=${encodeURIComponent(name)}`);
      return;
    }
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    switch (body?.error) {
      case "NOT_FOUND":
        setError(t("errorNotFound"));
        break;
      case "CONFLICT":
        setError(t("folderRenameErrorConflict"));
        break;
      case "LOCKED":
        setError(t("errorLocked"));
        break;
      case "INVALID_NAME":
        setError(t("folderRenameErrorInvalid"));
        break;
      // 目录已改名、配置没跟上：重试只会得到 NOT_FOUND（旧目录已不在），
      // 用通用的"请稍后重试"会把用户引到错误的动作上
      case "MOVE_PARTIAL":
        setError(t("errorMovePartial"));
        break;
      // 批 3：涉及档案目录（本身/子目录/祖先目录）。哪份档案挡住的是动态
      // 内容，不铺一套新的静态文案——与 repo-dialogs.tsx 的既有做法一致，
      // 直接展示服务端 message（去掉 "CODE: " 前缀，只留有信息量的部分）
      case "INVALID_PATH":
        setError((body?.message ?? t("errorRequest")).replace(/^[A-Z_]+:\s*/, ""));
        break;
      default:
        setError(t("errorRequest"));
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => onOpenChange(true)}>
        <Pencil className="size-3.5" />
        {t("folderRenameButton")}
      </Button>

      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("folderRenameTitle")}</DialogTitle>
            <DialogDescription>
              {affectedModelCount > 0
                ? t("folderRenameAffected", { count: affectedModelCount })
                : t("folderRenameNoAffected")}
            </DialogDescription>
          </DialogHeader>

          <Input
            className="font-mono"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-invalid={error !== null}
          />
          {error && <p className="text-xs text-destructive">{error}</p>}

          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={busy} />}>
              {t("cancel")}
            </DialogClose>
            <Button
              disabled={busy || value.trim() === "" || value.trim() === folder}
              onClick={onConfirm}
            >
              {busy && <Loader2 className="animate-spin" />}
              {busy ? t("folderRenaming") : t("folderRenameConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
