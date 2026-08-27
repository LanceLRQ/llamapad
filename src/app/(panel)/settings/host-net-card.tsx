"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Loader2, Network, XCircle } from "lucide-react";

import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiFetch } from "@/lib/api";

/**
 * 设置页「网络监控网卡」卡片（追加需求 2026-08-27：宿主机网络指标允许用户
 * 选择监控哪一块网卡，默认自动选；照抄 hf-card.tsx 的
 * 按钮/选择 → apiFetch → 就地更新快照结构）。
 *
 * 只有一个操作：Select 选中即 PUT（不需要单独的"保存"按钮，与
 * refresh-interval-select.tsx 的即选即生效体验一致——这不是需要二次确认的
 * 破坏性操作）。"自动" 选项的文案里带上当前实际选中的网卡（resolvedIface），
 * 否则用户看到"自动"不知道自动选的结果对不对。
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
  const [error, setError] = useState<string | null>(null);

  async function onChange(next: string): Promise<void> {
    if (busy || next === snap.preference) return;
    setBusy(true);
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
    router.refresh();
  }

  const autoLabel =
    snap.resolvedIface !== null
      ? t("autoOptionCurrent", { iface: snap.resolvedIface })
      : t("autoOptionUnknown");

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2.5 border-b px-4 py-3">
        <Network className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{t("title")}</h2>
        <span className="text-xs text-muted-foreground">{t("description")}</span>
      </div>

      <div className="flex flex-col gap-2 px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={snap.preference}
            onValueChange={(value) => {
              if (value !== null) void onChange(value);
            }}
          >
            <SelectTrigger size="sm" className="w-64" disabled={busy}>
              <SelectValue>{snap.preference === AUTO_VALUE ? autoLabel : snap.preference}</SelectValue>
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
        {snap.availableIfaces.length === 0 && (
          <p className="text-xs text-muted-foreground">{t("noIfaces")}</p>
        )}
      </div>
    </Card>
  );
}
