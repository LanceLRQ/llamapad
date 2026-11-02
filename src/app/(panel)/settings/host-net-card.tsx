"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Loader2, Network, XCircle } from "lucide-react";

import { SettingsSaveFooter } from "@/components/settings-save-footer";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiFetch } from "@/lib/api";
import { SettingTip } from "@/components/setting-tip";

/**
 * 设置页「网络监控网卡」卡片（追加需求 2026-08-27：宿主机网络指标允许用户
 * 选择监控哪一块网卡，默认自动选；照抄 hf-card.tsx 的
 * 按钮/选择 → apiFetch → 就地更新快照结构）。
 *
 * 选择只修改本地草稿，点击「保存设置」后写入。「自动」选项保留实际网卡名称。
 */

const AUTO_VALUE = "auto";

/** 快照形状（与 GET /api/v1/settings/host-net 响应及 hostNetSettings.ts 同构） */
export interface HostNetSettingsSnapshotView {
  preference: string;
  resolvedIface: string | null;
  availableIfaces: string[];
}

export function HostNetCard({ initial }: { initial: HostNetSettingsSnapshotView }) {
  const t = useTranslations("pages.settings.hostNet");
  const tCommon = useTranslations("pages.settings");
  const router = useRouter();

  const [snap, setSnap] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(initial.preference);
  const [saved, setSaved] = useState(false);
  const dirty = draft !== snap.preference;
  const [error, setError] = useState<string | null>(null);

  async function onSave(): Promise<void> {
    const next = draft;
    if (busy || next === snap.preference) return;
    setBusy(true);
    setSaved(false);
    setError(null);
    const res = await apiFetch("/api/v1/settings/host-net", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ iface: next }),
    }).catch(() => null);
    setBusy(false);
    if (res === null) {
      setError(tCommon("errorNetwork"));
      return;
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(data?.error ?? tCommon("errorRequest"));
      return;
    }
    setSnap((await res.json()) as HostNetSettingsSnapshotView);
    setSaved(true);
    router.refresh();
  }

  const autoLabel =
    snap.resolvedIface !== null
      ? t("autoOptionCurrent", { iface: snap.resolvedIface })
      : t("autoOptionUnknown");

  return (
    <Card className="gap-0 py-0">
      <div className="flex flex-wrap items-center gap-2.5 border-b p-4">
        <Network className="size-4 text-muted-foreground" />
        <div className="flex items-center gap-1">
          <h2 className="text-base font-semibold">{t("title")}</h2>
          <SettingTip text={t("description")} />
        </div>
      </div>

      <div className="flex flex-col gap-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={draft}
            onValueChange={(value) => {
              if (value !== null) setDraft(value);
            }}
          >
            <SelectTrigger size="sm" className="w-64" disabled={busy}>
              <SelectValue>{draft === AUTO_VALUE ? autoLabel : draft}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTO_VALUE}>{autoLabel}</SelectItem>
              {snap.availableIfaces.map((iface) => (
                <SelectItem key={iface} value={iface}>
                  {iface}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {busy && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        </div>
        {error && (
          <p className="flex items-center gap-1.5 text-xs text-destructive">
            <XCircle className="size-3.5 shrink-0" />
            {error}
          </p>
        )}
        {/* A 级：网络指标将缺失，状态歧义，不做灰色小字 */}
        {snap.availableIfaces.length === 0 && (
          <p className="text-sm text-foreground">{t("noIfaces")}</p>
        )}
        <SettingsSaveFooter dirty={dirty} busy={busy} saved={saved} onSave={() => void onSave()} />
      </div>
    </Card>
  );
}
