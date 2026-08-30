"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FolderPlus, Loader2 } from "lucide-react";
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
 * 「新建文件夹」入口（阶段 3b C5）：在当前面包屑位置下创建一个子目录。
 * 输入框只收单段名字（不接受 "/"）——"在哪创建"由当前所在的面包屑位置
 * 决定，不是靠用户在名字里拼路径；这与面包屑本身"一次只下钻一层"的
 * 交互模型一致，也避免用户用一个输入框意外跳过中间层级创建深层目录。
 *
 * 只在 folder 视图（含根目录）出现，与 FilesBreadcrumb 同一行——"新建"
 * 这个动作依赖"当前位置"这个上下文，"全部文件"/"文件元信息"两个伪视图
 * 没有这个上下文，不提供入口。
 */
export function CreateFolderDialog({ parentPath }: { parentPath: string }) {
  const t = useTranslations("pages.files");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  // 服务端 assertValidFolderName 还会挡 ".." 段与隐藏目录段，这里只提前
  // 挡最常见的误输入（含 "/" 相当于绕过面包屑直接拼多级路径），减少一趟
  // 无意义的请求往返；服务端校验仍是最终裁决，不因为这里放行了就假定合法
  const invalid = trimmed === "" || trimmed.includes("/");

  function onOpenChange(next: boolean) {
    if (busy) return;
    if (next) {
      setName("");
      setError(null);
    }
    setOpen(next);
  }

  async function onConfirm() {
    if (invalid || busy) return;
    const path = parentPath === "" ? trimmed : `${parentPath}/${trimmed}`;
    setBusy(true);
    setError(null);
    const res = await apiFetch("/api/v1/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    }).catch(() => null);
    setBusy(false);

    if (res === null) {
      setError(t("errorNetwork"));
      return;
    }
    if (res.ok) {
      setOpen(false);
      // 跳到新建成的目录，而不是 router.refresh() 停在原地——新建之后
      // 最自然的下一步就是看看这个空目录，与改名成功后的既有跳转习惯一致
      router.push(`/files?path=${encodeURIComponent(path)}`);
      return;
    }
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    switch (body?.error) {
      case "CONFLICT":
        setError(t("folderCreateErrorConflict"));
        break;
      case "INVALID_NAME":
        setError(t("folderCreateErrorInvalid"));
        break;
      default:
        setError(t("errorRequest"));
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => onOpenChange(true)}>
        <FolderPlus className="size-3.5" />
        {t("folderCreateButton")}
      </Button>

      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("folderCreateTitle")}</DialogTitle>
            <DialogDescription>
              {t("folderCreateDescription", { parent: parentPath === "" ? t("breadcrumbRoot") : parentPath })}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t("folderCreateLabel")}</span>
            <Input
              className="font-mono"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={error !== null}
              onKeyDown={(e) => {
                if (e.key === "Enter") onConfirm();
              }}
              autoFocus
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}

          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={busy} />}>{t("cancel")}</DialogClose>
            <Button disabled={invalid || busy} onClick={onConfirm}>
              {busy && <Loader2 className="animate-spin" />}
              {busy ? t("folderCreating") : t("folderCreateConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
