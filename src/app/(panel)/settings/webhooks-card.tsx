"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  CheckCircle2,
  Loader2,
  Play,
  Plus,
  Save,
  Trash2,
  Webhook as WebhookIcon,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { apiFetch } from "@/lib/api";
import { randomId } from "@/lib/uuid";
import type { WebhookConfig } from "@/core/webhook";

/**
 * 设置页「Webhook 通知」卡片（UX P1 U24，client；照抄 hf-card.tsx 的
 * 按钮 → apiFetch → 双态提示结构）：
 * - 渠道列表整表编辑（新增/删除只改本地草稿），点「保存」才 PUT 整表替换
 *   （与派发器/路由的「全量替换数组」语义一致）——未保存时禁用「测试推送」，
 *   因为测试路由按 id 从服务端已保存的配置里查找，新增未保存的行查不到
 * - 每行「测试推送」：POST /api/v1/settings/webhooks/test，只读 { ok, status }，
 *   响应体从不展示（风险簿⑥）
 * - 订阅分组：复选框多选事件前缀，全不选 = 订阅全部（与 matchEvent 语义一致）
 */

/** 渠道类型可选项 */
const CHANNEL_TYPES: WebhookConfig["type"][] = ["bark", "telegram", "wecom", "custom"];

/** 订阅分组：按 kind 前缀（与 server/webhookDispatcher.ts 的 matchEvent 前缀匹配语义一致） */
const KIND_GROUPS: { prefix: string; labelKey: string }[] = [
  { prefix: "download.", labelKey: "kindDownload" },
  { prefix: "model.", labelKey: "kindModel" },
  { prefix: "auth.", labelKey: "kindAuth" },
  { prefix: "namespace.", labelKey: "kindNamespace" },
  { prefix: "config.", labelKey: "kindConfig" },
  { prefix: "file.", labelKey: "kindFile" },
  { prefix: "repo.", labelKey: "kindRepo" },
];

/** 新增一行草稿：类型默认 custom（无需额外 token 字段最省事） */
function makeDraft(): WebhookConfig {
  // randomId 而非 crypto.randomUUID：后者只在安全上下文暴露，面板真机是 HTTP
  // 局域网访问，直接调用会抛异常把整页打白（lib/uuid.ts 顶部注释详述根因）
  return { id: randomId(), type: "custom", url: "", token: "", enabled: true, kinds: [] };
}

/** 单渠道测试结果 */
type TestState = { busy: boolean; result: { ok: boolean; status: number | null } | null };

export function WebhooksCard({ initial }: { initial: WebhookConfig[] }) {
  const t = useTranslations("pages.settings.webhooks");
  const tCommon = useTranslations("pages.settings");
  const router = useRouter();

  const [channels, setChannels] = useState<WebhookConfig[]>(initial);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testState, setTestState] = useState<Record<string, TestState>>({});

  function updateRow(id: string, patch: Partial<WebhookConfig>): void {
    setChannels((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
    setDirty(true);
    setSaveError(null);
  }

  function toggleKind(id: string, prefix: string): void {
    setChannels((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c;
        const kinds = c.kinds.includes(prefix) ? c.kinds.filter((k) => k !== prefix) : [...c.kinds, prefix];
        return { ...c, kinds };
      }),
    );
    setDirty(true);
    setSaveError(null);
  }

  function addRow(): void {
    setChannels((prev) => [...prev, makeDraft()]);
    setDirty(true);
    setSaveError(null);
  }

  function removeRow(id: string): void {
    setChannels((prev) => prev.filter((c) => c.id !== id));
    setDirty(true);
    setSaveError(null);
  }

  async function onSave(): Promise<void> {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    // 空 url 的草稿行大概率是刚点「新增」还没填写完，拦在前端省一次 400 往返
    const invalid = channels.find((c) => c.url.trim() === "");
    if (invalid) {
      setSaving(false);
      setSaveError(t("errorEmptyUrl"));
      return;
    }
    const res = await apiFetch("/api/v1/settings/webhooks", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(channels),
    }).catch(() => null);
    setSaving(false);
    if (res === null) {
      setSaveError(tCommon("errorNetwork"));
      return;
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setSaveError(data?.error ?? tCommon("errorRequest"));
      return;
    }
    setChannels((await res.json()) as WebhookConfig[]);
    setDirty(false);
    setTestState({});
    router.refresh();
  }

  async function onTest(id: string): Promise<void> {
    setTestState((prev) => ({ ...prev, [id]: { busy: true, result: null } }));
    const res = await apiFetch("/api/v1/settings/webhooks/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => null);
    if (res === null) {
      setTestState((prev) => ({ ...prev, [id]: { busy: false, result: { ok: false, status: null } } }));
      return;
    }
    const data = (await res.json().catch(() => null)) as { ok?: boolean; status?: number | null } | null;
    setTestState((prev) => ({
      ...prev,
      [id]: { busy: false, result: { ok: data?.ok === true, status: data?.status ?? null } },
    }));
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2.5 border-b p-4">
        <WebhookIcon className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{t("title")}</h2>
        <span className="text-xs text-muted-foreground">{t("description")}</span>
      </div>

      <div className="flex flex-col gap-4 p-4">
        {channels.length === 0 && <p className="text-xs text-muted-foreground">{t("empty")}</p>}

        {/* 渠道数量没有上限，用 max-h + 内部滚动兜住；每个渠道卡片本身比表格行
            高得多，max-h 给得比表格类列表大一些。max-h 而非 h——渠道少时写死
            高度会留一大截空白 */}
        <div className="flex max-h-[28rem] flex-col gap-3 overflow-y-auto">
          {channels.map((channel) => {
            const state = testState[channel.id];
            return (
              <div key={channel.id} className="flex flex-col gap-2.5 rounded-lg border px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value={channel.type}
                    onValueChange={(v) => updateRow(channel.id, { type: v as WebhookConfig["type"] })}
                  >
                    <SelectTrigger size="sm" className="w-32">
                      <SelectValue>{t(`type_${channel.type}`)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {CHANNEL_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {t(`type_${type}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <Input
                    className="min-w-56 flex-1 font-mono"
                    placeholder={t("urlPlaceholder")}
                    value={channel.url}
                    onChange={(e) => updateRow(channel.id, { url: e.target.value })}
                  />

                  <div className="flex items-center gap-1.5">
                    <Switch
                      checked={channel.enabled}
                      onCheckedChange={(checked) => updateRow(channel.id, { enabled: checked === true })}
                    />
                    <Label className="text-xs text-muted-foreground">{t("enabled")}</Label>
                  </div>

                  <Button variant="ghost" size="sm" onClick={() => removeRow(channel.id)}>
                    <Trash2 className="size-3.5" />
                    {t("remove")}
                  </Button>
                </div>

                {(channel.type === "telegram" || channel.type === "wecom") && (
                  <Input
                    className="max-w-sm font-mono"
                    placeholder={
                      channel.type === "telegram" ? t("tokenPlaceholderTelegram") : t("tokenPlaceholderWecom")
                    }
                    value={channel.token ?? ""}
                    onChange={(e) => updateRow(channel.id, { token: e.target.value })}
                  />
                )}

                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">{t("kindsLabel")}</Label>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                    {KIND_GROUPS.map((group) => (
                      <label key={group.prefix} className="flex items-center gap-1.5 text-xs">
                        <Checkbox
                          checked={channel.kinds.includes(group.prefix)}
                          onCheckedChange={() => toggleKind(channel.id, group.prefix)}
                        />
                        {t(group.labelKey)}
                      </label>
                    ))}
                  </div>
                  {/* 上下文感知的条件提示（复核修正）：只在用户恰好未勾选任何分组时出现，
                      告知这一刻的实际含义（全部订阅），比常驻 `?` 更贴合时机 */}
                  {channel.kinds.length === 0 && (
                    <p className="text-xs text-muted-foreground">{t("kindsAllHint")}</p>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={dirty || state?.busy}
                    onClick={() => onTest(channel.id)}
                  >
                    {state?.busy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                    {state?.busy ? t("testing") : t("testButton")}
                  </Button>
                  {dirty && <span className="text-xs text-muted-foreground">{t("testDisabledDirtyHint")}</span>}
                  {!dirty && state?.result?.ok && (
                    <p className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 className="size-3.5 shrink-0" />
                      {t("testOk", { status: state.result.status ?? 0 })}
                    </p>
                  )}
                  {!dirty && state?.result && !state.result.ok && (
                    <p className="flex items-center gap-1.5 text-xs text-destructive">
                      <XCircle className="size-3.5 shrink-0" />
                      {state.result.status !== null
                        ? t("testFailStatus", { status: state.result.status })
                        : t("testFailNetwork")}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t pt-3.5">
          <Button variant="outline" size="sm" onClick={addRow}>
            <Plus className="size-3.5" />
            {t("addButton")}
          </Button>
          <Button size="sm" disabled={saving || !dirty} onClick={onSave}>
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
            {saving ? t("saving") : t("saveButton")}
          </Button>
          {saveError && <p className="text-xs text-destructive">{saveError}</p>}
        </div>
      </div>
    </Card>
  );
}
