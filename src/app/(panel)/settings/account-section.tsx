"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Check, Copy, Eye, EyeOff, KeyRound, KeySquare, Loader2, ShieldBan, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { copyTextToClipboard } from "@/lib/clipboard";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiFetch } from "@/lib/api";

/**
 * 设置页「账号与安全」区块（M5 Task 8，client）：API token 列表/签发/查看/吊销 + 管理员密码说明。
 * - 列表初值由 server 侧装配传入（listApiTokens，不含明文），每次签发/吊销后
 *   router.refresh() 重取（实时性策略与命名空间区块一致）
 * - 签发：POST /api/v1/auth/tokens，用户在签发时勾选是否保存明文（storePlain，默认不勾选，
 *   安全默认——见 server/auth.ts issueApiToken 头注释）；勾选后明文入库、可随时在列表里
 *   展开查看，未勾选时明文只在这次签发响应里出现一次，弹层关闭后再也拿不回来，只能吊销重发
 * - 查看：只有 storePlain 为 true 那批 token 才能反复查看（server/auth.ts 头注释同一处
 *   取舍）。列表默认只显示遮蔽串，首次点击眼睛按钮才 GET /api/v1/auth/tokens/:id 取明文，
 *   取回后缓存进组件 state，同一行再次展开/收起不再发请求；复制按钮同样按需取，不要求
 *   先展开。没有明文的行（未勾选保存，或早于明文功能签发的历史行）眼睛与复制按钮
 *   disabled，只能吊销重发
 * - 吊销：DELETE /api/v1/auth/tokens/:id，确认 Dialog（删行即失效）
 * - 管理员密码：以部署配置 PANEL_ADMIN_PASSWORD 为唯一真源，面板不提供改密入口
 *   （见 server/auth.ts 的 syncAdminPasswordFromEnv），这里只放说明
 */

/** 一行 token（与 GET /api/v1/auth/tokens 响应及 server/auth.ts 的 ApiTokenRow 同构，客户端不引 server 模块） */
export interface ApiTokenEntry {
  id: number;
  name: string | null;
  createdAt: string;
  tail: string;
  /** 是否可查看明文。token_tail 是 v4 就加的列，v4~v17 之间签发的行 tail 非空但没有
   *  明文，能不能查看只能看这个字段，不能靠 tail 是否为空来判定（那样会把这批行误判
   *  成可查看，点开眼睛必 404）。 */
  hasPlain: boolean;
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
  /** 是否保存明文：默认不勾选（安全默认，与 route 侧缺省一致） */
  const [draftStorePlain, setDraftStorePlain] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  /** 本次签发是否保存了明文：决定 freshToken 提示条展示"可在列表查看"还是
   *  "关闭后无法再次查看"，与 draftStorePlain 分开是因为用户可能在签发成功后又改动勾选框 */
  const [freshTokenStorePlain, setFreshTokenStorePlain] = useState(false);
  /** 复制反馈三态：HTTP 局域网下 clipboard API 可能不可用，失败必须可见（不可静默） */
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  // 吊销
  const [revoking, setRevoking] = useState<ApiTokenEntry | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  // 查看明文：按 id 缓存/展开态/加载态/按行反馈，避免一行的状态串到另一行
  const [revealedTokens, setRevealedTokens] = useState<Record<number, string>>({});
  const [visibleIds, setVisibleIds] = useState<Set<number>>(new Set());
  const [revealingIds, setRevealingIds] = useState<Set<number>>(new Set());
  const [rowError, setRowError] = useState<Record<number, string>>({});
  const [rowCopyState, setRowCopyState] = useState<Record<number, "copied" | "failed">>({});

  /** 取某行明文：命中缓存直接返回，否则 GET 取回并缓存；失败就地记录该行错误，不弹全局报错。
   *  每次调用先清掉该行旧的 error——不清的话，切到别的行再切回来时上一次失败的提示还挂着，
   *  容易让人以为这次也失败了。 */
  async function revealToken(id: number): Promise<string | null> {
    setRowError((prev) => {
      const { [id]: _drop, ...rest } = prev;
      return rest;
    });
    const cached = revealedTokens[id];
    if (cached !== undefined) return cached;

    const res = await apiFetch(`/api/v1/auth/tokens/${id}`).catch(() => null);
    if (res === null || !res.ok) {
      setRowError((prev) => ({ ...prev, [id]: t("tokenRevealFailed") }));
      return null;
    }
    const data = (await res.json().catch(() => null)) as { token?: string } | null;
    if (!data?.token) {
      setRowError((prev) => ({ ...prev, [id]: t("tokenRevealFailed") }));
      return null;
    }
    setRevealedTokens((prev) => ({ ...prev, [id]: data.token! }));
    return data.token;
  }

  async function onToggleReveal(entry: ApiTokenEntry) {
    if (!entry.hasPlain || revealingIds.has(entry.id)) return;
    if (visibleIds.has(entry.id)) {
      // 已展开：收起不需要重新取值，缓存留着供下次直接展开
      setVisibleIds((prev) => {
        const next = new Set(prev);
        next.delete(entry.id);
        return next;
      });
      return;
    }
    setRevealingIds((prev) => new Set(prev).add(entry.id));
    const token = await revealToken(entry.id);
    setRevealingIds((prev) => {
      const next = new Set(prev);
      next.delete(entry.id);
      return next;
    });
    if (token !== null) {
      setVisibleIds((prev) => new Set(prev).add(entry.id));
    }
  }

  async function onCopyRow(entry: ApiTokenEntry) {
    if (!entry.hasPlain) return;
    const token = await revealToken(entry.id);
    if (token === null) {
      setRowCopyState((prev) => ({ ...prev, [entry.id]: "failed" }));
      return;
    }
    const ok = await copyTextToClipboard(token);
    setRowCopyState((prev) => ({ ...prev, [entry.id]: ok ? "copied" : "failed" }));
  }

  async function onCreate() {
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    const res = await apiFetch("/api/v1/auth/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: draftName.trim() === "" ? null : draftName.trim(),
        storePlain: draftStorePlain,
      }),
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
    setFreshTokenStorePlain(draftStorePlain);
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

  return (
    // gap-0 py-0：Card 默认自带上下内边距与子项间距，设置页这套卡片是
    // 表头 + 内容各自 p-4 的写法，子元素已经有内边距，不覆盖就是双层内边距
    <Card className="gap-0 py-0">
      <div className="flex flex-wrap items-center gap-2.5 border-b p-4">
        <KeyRound className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{t("accountTitle")}</h2>
      </div>

      <div className="flex flex-col gap-5 p-4">
        {/* API Token */}
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">{t("tokenListTitle")}</h3>
          {/* A 级：是否保存明文由签发时的勾选决定——常驻且不做灰色小字 */}
          <p className="text-sm text-foreground">{t("tokenListHint")}</p>

          {freshToken !== null && (
            <div className="flex flex-col gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
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
              {/* 未保存明文时这是唯一一次能看到它的机会，弹层关闭即永久丢失——必须显著提示 */}
              <p
                className={cn(
                  "text-xs",
                  freshTokenStorePlain ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400",
                )}
              >
                {freshTokenStorePlain ? t("tokenCreatedViewLater") : t("tokenCreatedNoPlainWarn")}
              </p>
            </div>
          )}

          {/* API token 数量没有上限，用 max-h + 内部滚动兜住；max-h 而非
              h——条目少时写死高度会留一截空白，比列表滚动更难看 */}
          <div className="max-h-72 overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("tokenColName")}</TableHead>
                  <TableHead className="w-[220px]">{t("tokenColSecret")}</TableHead>
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
                    <TableCell className="text-[13px]">
                      <div className="flex items-center gap-1">
                        {/* 展开态换成 break-all：明文 46 字符在这一列里必然超宽，
                            继续 truncate 就成了「点了查看仍看不全」，宁可折行 */}
                        <span
                          className={cn(
                            "min-w-0 flex-1 font-mono tabular-nums",
                            visibleIds.has(entry.id) ? "break-all" : "truncate",
                          )}
                        >
                          {!entry.hasPlain ? (
                            <span className="text-xs whitespace-normal text-muted-foreground">
                              {t("tokenPlainUnavailable")}
                            </span>
                          ) : visibleIds.has(entry.id) && revealedTokens[entry.id] !== undefined ? (
                            revealedTokens[entry.id]
                          ) : (
                            `lp_····${entry.tail}`
                          )}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          disabled={!entry.hasPlain || revealingIds.has(entry.id)}
                          onClick={() => onToggleReveal(entry)}
                          aria-label={visibleIds.has(entry.id) ? t("tokenHide") : t("tokenReveal")}
                        >
                          {revealingIds.has(entry.id) ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : visibleIds.has(entry.id) ? (
                            <EyeOff className="size-3.5" />
                          ) : (
                            <Eye className="size-3.5" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          disabled={!entry.hasPlain}
                          onClick={() => onCopyRow(entry)}
                          aria-label={t("tokenCopy")}
                        >
                          {rowCopyState[entry.id] === "copied" ? (
                            <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                          ) : rowCopyState[entry.id] === "failed" ? (
                            <X className="size-3.5 text-destructive" />
                          ) : (
                            <Copy className="size-3.5" />
                          )}
                        </Button>
                      </div>
                      {rowError[entry.id] && (
                        <p className="text-xs text-destructive">{rowError[entry.id]}</p>
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
          </div>

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
            {/* 默认不勾选（安全默认）：勾选后明文才会一并入库，换取之后能在列表里反复查看/复制 */}
            <label className="flex max-w-md items-start gap-1.5 text-xs text-muted-foreground">
              <Checkbox
                className="mt-0.5"
                checked={draftStorePlain}
                onCheckedChange={(checked) => setDraftStorePlain(checked === true)}
              />
              <span className="flex flex-col gap-0.5">
                <span>{t("tokenStorePlainLabel")}</span>
                <span>{t("tokenStorePlainRisk")}</span>
              </span>
            </label>
            {createError && <p className="text-xs text-destructive">{createError}</p>}
          </div>
        </div>

        {/* 管理员密码：只读说明 */}
        <div className="flex flex-col gap-2 border-t pt-4">
          <h3 className="text-sm font-semibold">{t("pwTitle")}</h3>
          {/* A 级：改密入口不在面板里，属用户找不到入口时的关键信息，常驻且不做灰色小字 */}
          <p className="max-w-xl text-sm text-foreground">{t("pwManagedHint")}</p>
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
                {revoking && revoking.tail !== "" ? `（lp_····${revoking.tail}）` : ""}
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
