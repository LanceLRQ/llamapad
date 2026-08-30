"use client";

import { useState } from "react";
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
 * 「新建文件夹」弹层（阶段 3b C5 起在文件页落地；阶段 4 D1 抽成共享组件，
 * 供文件页面包屑与向导第 3 步「存放位置」共用）：在 parentPath 下建一个
 * 单段子目录，命名规则、错误文案两处完全一致，唯一的差异是"建完之后干
 * 什么"——文件页建完想直接跳进新目录看看，向导建完只是想把这个新目录选
 * 进当前的存放位置下拉，不该跳页把向导已经填的进度弄丢。这个差异交给
 * 调用方的 onCreated 回调决定，本组件自己不做任何导航。
 *
 * 输入框只收单段名字（不接受 "/"）——"在哪创建"由 parentPath 决定，不是
 * 靠用户在名字里拼路径，这与面包屑"一次只下钻一层"的交互模型一致。
 */
export function CreateFolderDialog({
  parentPath,
  onCreated,
}: {
  parentPath: string;
  onCreated: (path: string) => void;
}) {
  const t = useTranslations("pages.files");
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
      onCreated(path);
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
