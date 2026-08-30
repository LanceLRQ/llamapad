"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";

/**
 * 「新建命名空间」弹层（阶段 4 D4）：POST /api/v1/namespaces 的界面部分，
 * 供向导第 1 步的 Select 哨兵项、模型页二级栏「＋」入口共用（之前是各自
 * 一份内联实现，见调用处注释）。设置页命名空间卡的新建是常驻可见的行内
 * 输入框（不是弹层），且那张卡还带重命名/删除两个已有 Dialog，为了复用
 * 硬套反而会改变现有 UX 与徒增改动面，保持现状，见 namespaces-card.tsx。
 *
 * 完全受控（open/onOpenChange 由调用方持有）：向导需要在 Select 选中哨兵
 * 值时弹出而不改变 Select 自身的选中项（取消后不留下"新建中"的中间态），
 * 模型页需要点一个独立的触发按钮弹出——两种触发方式共用同一份"弹层内部
 * 状态"没有意义，交给调用方各自决定何时 open，本组件只管"打开后怎么把
 * 命名空间建出来"这一件事。
 *
 * 字符集提示复用 pages.modelsNew 的既有文案（阶段 2 放开正则时已经同步
 * 更新过），不再新写一份措辞。
 */
export function NamespaceCreateDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (name: string) => void;
}) {
  const t = useTranslations("pages.modelsNew");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleOpenChange(next: boolean) {
    if (busy) return;
    if (next) {
      setName("");
      setError(null);
    }
    onOpenChange(next);
  }

  async function onConfirm() {
    const trimmed = name.trim();
    if (trimmed === "" || busy) return;
    setBusy(true);
    setError(null);
    const res = await apiFetch("/api/v1/namespaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: trimmed }),
    }).catch(() => null);
    setBusy(false);

    if (res === null) {
      setError(t("errorNetwork"));
      return;
    }
    if (res.ok) {
      handleOpenChange(false);
      onCreated(trimmed);
      return;
    }
    if (res.status === 409) setError(t("namespaceDuplicate"));
    else if (res.status === 400) setError(t("namespaceInvalid"));
    else setError(t("errorNamespaceRequest"));
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("namespaceCreateTitle")}</DialogTitle>
        </DialogHeader>

        <Input
          className="font-mono"
          placeholder={t("newNamespacePlaceholder")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={error !== null || undefined}
          onKeyDown={(e) => {
            if (e.key === "Enter") void onConfirm();
          }}
          autoFocus
        />
        {error && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={busy} />}>{t("cancel")}</DialogClose>
          <Button disabled={name.trim() === "" || busy} onClick={() => void onConfirm()}>
            {busy && <Loader2 className="animate-spin" />}
            {busy ? t("creatingNamespace") : t("createNamespace")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
