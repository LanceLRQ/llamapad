"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Check, Copy, KeyRound, KeySquare, Loader2, ShieldBan, X } from "lucide-react";

import { copyTextToClipboard } from "@/lib/clipboard";
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
import { Label } from "@/components/ui/label";
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
 * 设置页「账号与安全」区块（M5 Task 8，client）：API token 列表/签发/吊销 + 管理员改密码。
 * - 列表初值由 server 侧装配传入（listApiTokens，不含明文），每次签发/吊销后
 *   router.refresh() 重取（实时性策略与命名空间区块一致）
 * - 签发：POST /api/v1/auth/tokens，明文只在响应后展示一次（复制按钮 + 关闭即弃），
 *   列表里只有尾 4 位；早于 v4 签发的旧 token 尾号为空，显示占位
 * - 吊销：DELETE /api/v1/auth/tokens/:id，确认 Dialog（删行即失效）
 * - 改密码：PUT /api/v1/auth/password；改密不吊销已签发 token（吊销有独立入口）
 */

/** 一行 token（与 GET /api/v1/auth/tokens 响应及 server/auth.ts 的 ApiTokenRow 同构，客户端不引 server 模块） */
export interface ApiTokenEntry {
  id: number;
  name: string | null;
  createdAt: string;
  tail: string;
}

/** createdAt → 本地化日期时间（与命名空间区块同款格式） */
function formatCreatedAt(iso: string): string {
  return new Date(iso).toLocaleString("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function AccountSection({ initialTokens }: { initialTokens: ApiTokenEntry[] }) {
  const t = useTranslations("pages.settings");
  const router = useRouter();

  // 签发
  const [draftName, setDraftName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  /** 复制反馈三态：HTTP 局域网下 clipboard API 可能不可用，失败必须可见（不可静默） */
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  // 吊销
  const [revoking, setRevoking] = useState<ApiTokenEntry | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  // 改密码
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwDone, setPwDone] = useState(false);

  async function onCreate() {
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    const res = await apiFetch("/api/v1/auth/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: draftName.trim() === "" ? null : draftName.trim() }),
    }).catch(() => null);
    setCreating(false);

    if (res === null) {
      setCreateError(t("errorNetwork"));
      return;
    }
    const data = (await res.json().catch(() => null)) as { token?: string } | null;
    if (!res.ok || !data?.token) {
      setCreateError(t("errorRequest"));
      return;
    }
    setFreshToken(data.token);
    setCopyState("idle");
    setDraftName("");
    router.refresh();
  }

  async function onCopy() {
    if (freshToken === null) return;
    const ok = await copyTextToClipboard(freshToken);
    setCopyState(ok ? "copied" : "failed");
  }

  function dismissFresh() {
    setFreshToken(null);
    setCopyState("idle");
  }

  async function onConfirmRevoke() {
    if (revoking === null || revokeBusy) return;
    setRevokeBusy(true);
    setRevokeError(null);
    const res = await apiFetch(`/api/v1/auth/tokens/${revoking.id}`, { method: "DELETE" }).catch(
      () => null,
    );
    setRevokeBusy(false);

    if (res === null) {
      setRevokeError(t("errorNetwork"));
      return;
    }
    if (!res.ok) {
      setRevokeError(res.status === 404 ? t("tokenRevokedGone") : t("errorRequest"));
      return;
    }
    setRevoking(null);
    router.refresh();
  }

  async function onChangePw() {
    if (pwBusy) return;
    setPwDone(false);
    if (newPw.length < 8) {
      setPwError(t("pwTooShort"));
      return;
    }
    if (newPw !== confirmPw) {
      setPwError(t("pwMismatch"));
      return;
    }
    setPwBusy(true);
    setPwError(null);
    const res = await apiFetch("/api/v1/auth/password", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oldPassword: oldPw, newPassword: newPw }),
    }).catch(() => null);
    setPwBusy(false);

    if (res === null) {
      setPwError(t("errorNetwork"));
      return;
    }
    if (!res.ok) {
      setPwError(res.status === 403 ? t("pwWrongOld") : t("errorRequest"));
      return;
    }
    setOldPw("");
    setNewPw("");
    setConfirmPw("");
    setPwDone(true);
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2.5 border-b px-4 py-3">
        <KeyRound className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{t("accountTitle")}</h2>
      </div>

      <div className="flex flex-col gap-5 px-4 py-3.5">
        {/* API Token */}
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">{t("tokenListTitle")}</h3>
          {/* A 级：明文仅在签发时显示一次，之后只能吊销重发——常驻且不做灰色小字 */}
          <p className="text-sm text-foreground">{t("tokenListHint")}</p>

          {freshToken !== null && (
            <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-amber-700 dark:text-amber-400">
                  {t("tokenCreatedTitle")}
                </span>
                <button
                  type="button"
                  className="text-muted-foreground transition-colors hover:text-foreground"
                  onClick={dismissFresh}
                  aria-label={t("cancel")}
                >
                  <X className="size-4" />
                </button>
              </div>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1.5 font-mono text-xs">
                  {freshToken}
                </code>
                <Button variant="outline" size="sm" onClick={onCopy}>
                  {copyState === "copied" ? (
                    <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                  ) : copyState === "failed" ? (
                    <X className="size-3.5 text-destructive" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                  {copyState === "copied"
                    ? t("tokenCopied")
                    : copyState === "failed"
                      ? t("tokenCopyFailed")
                      : t("tokenCopy")}
                </Button>
              </div>
            </div>
          )}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("tokenColName")}</TableHead>
                <TableHead className="w-[150px]">{t("tokenColTail")}</TableHead>
                <TableHead className="w-[150px]">{t("tokenColCreated")}</TableHead>
                <TableHead className="w-[90px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {initialTokens.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="py-4 text-center text-xs text-muted-foreground">
                    {t("tokenEmpty")}
                  </TableCell>
                </TableRow>
              )}
              {initialTokens.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="font-mono text-[13px] font-semibold">
                    {entry.name ?? <span className="text-muted-foreground">{t("tokenUnnamed")}</span>}
                  </TableCell>
                  <TableCell className="font-mono text-[13px] tabular-nums">
                    {entry.tail !== "" ? (
                      `····${entry.tail}`
                    ) : (
                      <span className="text-xs text-muted-foreground">{t("tokenTailUnknown")}</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                    {formatCreatedAt(entry.createdAt)}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={revoking !== null}
                      onClick={() => {
                        setRevokeError(null);
                        setRevoking(entry);
                      }}
                    >
                      <ShieldBan className="size-3.5" />
                      {t("tokenRevoke")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className="flex flex-col gap-1.5">
            <div className="flex max-w-md items-center gap-2">
              <Input
                className="font-mono"
                placeholder={t("tokenCreatePlaceholder")}
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                aria-invalid={createError !== null}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onCreate();
                }}
              />
              <Button size="sm" disabled={creating} onClick={onCreate}>
                {creating ? <Loader2 className="size-3.5 animate-spin" /> : <KeySquare className="size-3.5" />}
                {creating ? t("tokenCreating") : t("tokenCreate")}
              </Button>
            </div>
            {createError && <p className="text-xs text-destructive">{createError}</p>}
          </div>
        </div>

        {/* 修改密码 */}
        <div className="flex flex-col gap-2 border-t pt-4">
          <h3 className="text-sm font-semibold">{t("pwTitle")}</h3>
          <div className="flex max-w-xl flex-col gap-2">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">{t("pwOld")}</Label>
              <Input
                type="password"
                autoComplete="current-password"
                value={oldPw}
                onChange={(e) => setOldPw(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">{t("pwNew")}</Label>
              <Input
                type="password"
                autoComplete="new-password"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">{t("pwConfirm")}</Label>
              <Input
                type="password"
                autoComplete="new-password"
                value={confirmPw}
                onChange={(e) => setConfirmPw(e.target.value)}
                aria-invalid={pwError !== null}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onChangePw();
                }}
              />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm" disabled={pwBusy || oldPw === "" || newPw === "" || confirmPw === ""} onClick={onChangePw}>
                {pwBusy ? <Loader2 className="size-3.5 animate-spin" /> : <KeyRound className="size-3.5" />}
                {pwBusy ? t("pwSubmitting") : t("pwSubmit")}
              </Button>
              {pwDone && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400">{t("pwDone")}</p>
              )}
              {pwError && <p className="text-xs text-destructive">{pwError}</p>}
            </div>
            {/* A 级：改密后环境变量不再生效，属状态歧义，常驻且不做灰色小字 */}
            <p className="text-sm text-foreground">{t("pwEnvHint")}</p>
          </div>
        </div>
      </div>

      {/* 吊销确认 Dialog */}
      <Dialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open && !revokeBusy) setRevoking(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("tokenRevoke")}</DialogTitle>
            <DialogDescription>
              <span className="break-all font-mono text-xs">
                {revoking?.name ?? t("tokenUnnamed")}
                {revoking && revoking.tail !== "" ? `（····${revoking.tail}）` : ""}
              </span>
            </DialogDescription>
          </DialogHeader>
          {/* A 级：吊销后程序立即失去访问权限，破坏性后果，常驻且不做灰色小字 */}
          <p className="text-sm text-foreground">{t("tokenRevokeConfirm")}</p>
          {revokeError && <p className="text-xs text-destructive">{revokeError}</p>}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={revokeBusy} />}>
              {t("cancel")}
            </DialogClose>
            <Button variant="destructive" disabled={revokeBusy} onClick={onConfirmRevoke}>
              {revokeBusy && <Loader2 className="animate-spin" />}
              {revokeBusy ? t("tokenRevoking") : t("tokenRevoke")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
