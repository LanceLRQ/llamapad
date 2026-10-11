"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Loader2, Pencil, Plus, Star, Trash2, Wifi } from "lucide-react";

import { toast } from "@/components/toast-store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { formatStartedAt } from "@/lib/relay-snippet";
import { PROBE_INTERVAL_MS } from "@/lib/upstream-health";
import type { UpstreamProbeView, UpstreamView } from "@/lib/upstream-types";
import { CopyField } from "./copy-field";
import { UpstreamDialog } from "./upstream-dialog";

/** 状态 → 文案键 */
const STATE_KEYS: Record<UpstreamView["state"], string> = {
  unknown: "stateUnknown",
  reachable: "stateReachable",
  unreachable: "stateUnreachable",
  disabled: "stateDisabled",
};

/** 状态徽标的配色；已停用与未知用中性色，可达 / 不可达用语义色 */
const STATE_STYLES: Record<UpstreamView["state"], string> = {
  unknown: "text-muted-foreground",
  reachable: "border-accent-green/25 bg-accent-green/10 text-accent-green",
  unreachable: "border-destructive/25 bg-destructive/10 text-destructive",
  disabled: "text-muted-foreground",
};

/** 弹窗状态：关闭 / 新增 / 编辑某个上游。seq 用作 key，让每次打开都是全新的草稿 */
type DialogState = { seq: number; editing: UpstreamView | null } | null;

/**
 * 外部上游列表（client）。列表状态由外层（relay-workspace.tsx）持有，服务端给初值，本组件负责轮询刷新：
 * - 挂载时触发一次探测（不可达的上游已停止定时探测，靠这一下发现恢复）
 * - 每个探测间隔拉一次列表刷新状态显示，只读面板缓存的状态，不额外触发探测
 * 增删改与设为默认之后既刷新本地列表，也 router.refresh() 让页面上方的接入信息跟着变。
 */
export function UpstreamsSection({
  items,
  setItems,
}: {
  items: UpstreamView[];
  /** 列表由外层持有（右侧「可用模型名」卡要读同一份），这里只负责刷新它 */
  setItems: (items: UpstreamView[]) => void;
}) {
  const t = useTranslations("pages.relay.upstreams");
  const router = useRouter();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [deleting, setDeleting] = useState<UpstreamView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const res = await apiFetch("/api/v1/upstreams").catch(() => null);
    if (res?.ok) setItems(((await res.json()) as { upstreams: UpstreamView[] }).upstreams);
  }, [setItems]);

  useEffect(() => {
    void apiFetch("/api/v1/upstreams/probe", { method: "POST" }).catch(() => null);
    const timer = setInterval(() => void reload(), PROBE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [reload]);

  async function afterChange() {
    await reload();
    router.refresh();
  }

  async function run(key: string, request: () => Promise<Response>): Promise<Response | null> {
    setBusy(key);
    const res = await request().catch(() => null);
    setBusy(null);
    if (res === null) toast.error(t("errorNetwork"));
    else if (!res.ok) toast.error(res.status === 404 ? t("errorNotFound") : t("errorRequest"));
    return res?.ok ? res : null;
  }

  async function onToggle(item: UpstreamView, enabled: boolean) {
    const res = await run(`toggle:${item.name}`, () =>
      apiFetch(`/api/v1/upstreams/${encodeURIComponent(item.name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      }),
    );
    if (res === null) return;
    if (!enabled && item.isDefault) toast.info(t("disableDefaultHint"));
    await afterChange();
  }

  async function onTest(item: UpstreamView) {
    const res = await run(`test:${item.name}`, () => apiFetch(`/api/v1/upstreams/${encodeURIComponent(item.name)}/test`, { method: "POST" }));
    if (res === null) return;
    const probe = (await res.json()) as UpstreamProbeView;
    if (!probe.ok) toast.error(t("testFail", { error: probe.error ?? "" }));
    else if (probe.status === 200) toast.success(t("testOk", { ms: probe.latencyMs }));
    else toast.info(t("testStatus", { status: probe.status ?? 0 }));
    await reload();
  }

  async function onSetDefault(item: UpstreamView) {
    const res = await run(`default:${item.name}`, () =>
      apiFetch("/api/v1/runtime/default-model", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: item.name }),
      }),
    );
    if (res !== null) await afterChange();
  }

  async function onConfirmDelete() {
    if (deleting === null) return;
    const res = await run(`delete:${deleting.name}`, () =>
      apiFetch(`/api/v1/upstreams/${encodeURIComponent(deleting.name)}`, { method: "DELETE" }),
    );
    if (res === null) return;
    setDeleting(null);
    await afterChange();
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold">{t("title")}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("description")}</p>
        </div>
        <Button size="sm" onClick={() => setDialog({ seq: Date.now(), editing: null })}>
          <Plus className="size-3.5" />
          {t("add")}
        </Button>
      </div>

      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          {t("empty")}
        </div>
      ) : (
        <div className="divide-y overflow-hidden rounded-xl border bg-card">
          {items.map((item) => {
            const checked = formatStartedAt(item.lastCheckedAt);
            return (
              <div key={item.name} className="px-4 py-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-base font-semibold">{item.displayName}</span>
                  <Badge
                    variant="outline"
                    className={cn("gap-1.5", STATE_STYLES[item.state])}
                    title={item.lastError ?? undefined}
                  >
                    <span className="size-1.5 rounded-full bg-current" />
                    {t(STATE_KEYS[item.state])}
                  </Badge>
                  {item.isDefault && <Badge variant="outline">{t("default")}</Badge>}
                  <span className="text-xs text-muted-foreground">
                    {checked !== null ? t("lastChecked", { time: checked }) : t("neverChecked")}
                  </span>
                </div>

                <div className="mt-2 flex flex-wrap gap-x-2 gap-y-1.5">
                  <CopyField variant="chip" tag={t("tagName")} value={item.name} />
                  {item.aliases.map((a) => {
                    const target = a.upstreamModel ?? item.upstreamModel;
                    return (
                      <CopyField key={a.alias} variant="chip" tag={t("tagAlias")} value={a.alias}>
                        {target !== null && `→ ${target}`}
                      </CopyField>
                    );
                  })}
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5">
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-0.5">
                    <span className="min-w-0 font-mono text-[13px] [overflow-wrap:anywhere]" title={item.baseUrl}>
                      <span className="mr-1.5 font-sans text-xs text-muted-foreground">{t("addrLabel")}</span>
                      {item.baseUrl}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {item.apiKeyTail !== null ? t("keyTail", { tail: item.apiKeyTail }) : t("keyNone")}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-1.5">
                    <label className="mr-1.5 inline-flex cursor-pointer items-center gap-1.5 text-[13px] whitespace-nowrap text-muted-foreground">
                      <Switch
                        checked={item.enabled}
                        disabled={busy !== null}
                        onCheckedChange={(next) => void onToggle(item, next)}
                      />
                      {item.enabled ? t("switchOn") : t("switchOff")}
                    </label>
                    <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void onTest(item)}>
                      {busy === `test:${item.name}` ? <Loader2 className="animate-spin" /> : <Wifi className="size-3.5" />}
                      {t("test")}
                    </Button>
                    {item.enabled && !item.isDefault && (
                      <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void onSetDefault(item)}>
                        <Star className="size-3.5" />
                        {t("setDefault")}
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy !== null}
                      aria-label={t("edit")}
                      title={t("edit")}
                      onClick={() => setDialog({ seq: Date.now(), editing: item })}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy !== null}
                      aria-label={t("delete")}
                      title={t("delete")}
                      onClick={() => setDeleting(item)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {dialog !== null && (
        <UpstreamDialog
          key={dialog.seq}
          editing={dialog.editing}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void afterChange();
          }}
        />
      )}

      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteTitle")}</DialogTitle>
            <DialogDescription>
              {t("deleteBody", { name: deleting?.name ?? "" })}
              {deleting?.isDefault ? ` ${t("deleteDefaultBody")}` : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              {t("cancel")}
            </Button>
            <Button variant="destructive" disabled={busy !== null} onClick={() => void onConfirmDelete()}>
              {busy !== null && <Loader2 className="animate-spin" />}
              {busy !== null ? t("deleting") : t("deleteConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
