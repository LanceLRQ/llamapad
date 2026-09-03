"use client";

import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { apiFetch } from "@/lib/api";
import { toast } from "@/components/toast-store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ParamPreset } from "@/server/repo/presets";

/**
 * 「我的预设」弹层：套用 + 删除（行内确认），替换原先 140px 的 Select。
 *
 * 换掉窄下拉的原因：真机预设名可以长达 48 字符，下拉里截断到看不出选的是哪条；
 * 且原先套用后立刻把受控值归位到 placeholder，看起来像什么都没发生。
 * 弹层里名称 `break-words` 全展示，套用有 toast 反馈。
 *
 * 删除用行内确认而不是弹层套弹层——弹层嵌套在这套 UI 里容易出焦点/层级问题。
 */
export function PresetPickerDialog({
  open,
  onOpenChange,
  presets,
  onApply,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  presets: ParamPreset[];
  /** 用户点「套用」：父组件负责把 preset.server 打进 drafts */
  onApply: (preset: ParamPreset) => void;
  /** 删除成功后通知父组件把它从列表里摘掉 */
  onDeleted: (id: number) => void;
}) {
  const tc = useTranslations("common");
  const [confirming, setConfirming] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  function handleOpenChange(next: boolean): void {
    // 关闭时把确认态归零，免得下次打开还停在「确定删除吗」
    if (!next) setConfirming(null);
    onOpenChange(next);
  }

  function applyPreset(preset: ParamPreset): void {
    onApply(preset);
    // 走 handleOpenChange 而不是直接 onOpenChange：用户可能先点了某条的「删除」
    // 展开确认行、又转头套用了另一条，这条路径同样要把确认态归零，
    // 否则下次打开弹层还停在「确定删除吗」上
    handleOpenChange(false);
    toast.success(tc("paramPresets.applyDone", { name: preset.name }));
  }

  async function confirmDelete(id: number): Promise<void> {
    if (busy) return;
    setBusy(true);
    const res = await apiFetch(`/api/v1/presets/${id}`, { method: "DELETE" }).catch(() => null);
    setBusy(false);

    // 204 无 body，不能 .json()；失败时保留 confirming 让用户能直接重试
    if (res === null || !res.ok) return void toast.error(tc("paramPresets.deleteFailed"));
    onDeleted(id);
    setConfirming(null);
    toast.success(tc("paramPresets.deleteDone"));
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{tc("paramPresets.userTitle")}</DialogTitle>
        </DialogHeader>
        {presets.length === 0 ? (
          <div className="rounded-md border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
            {tc("paramPresets.userEmpty")}
          </div>
        ) : (
          <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
            {presets.map((preset) => (
              <div key={preset.id} className="rounded-md border p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 flex-col gap-1">
                    <p className="break-words text-sm font-medium">{preset.name}</p>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline">
                        {tc(
                          preset.source === "manual"
                            ? "paramPresets.sourceManual"
                            : preset.source === "model"
                              ? "paramPresets.sourceModel"
                              : "paramPresets.sourceReadme",
                        )}
                      </Badge>
                      {preset.sourceRepo !== null && (
                        <span className="text-[11px] text-muted-foreground">
                          {tc("paramPresets.fromRepo", { repo: preset.sourceRepo })}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button type="button" size="sm" onClick={() => applyPreset(preset)}>
                      {tc("paramPresets.applyButton")}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      title={tc("paramPresets.deleteButton")}
                      onClick={() => setConfirming(preset.id)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
                  {Object.entries(preset.server).map(([field, value]) => (
                    <div key={field} className="flex items-baseline gap-1.5 font-mono text-[11px]">
                      <dt className="text-muted-foreground">{field}</dt>
                      <dd className="ml-auto font-medium">{String(value)}</dd>
                    </div>
                  ))}
                </dl>
                {confirming === preset.id && (
                  <div className="mt-2 flex items-center gap-2 rounded-md bg-muted/50 px-2.5 py-2">
                    <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                      {tc("paramPresets.deleteConfirmText")}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => setConfirming(null)}
                    >
                      {tc("paramPresets.deleteCancel")}
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      disabled={busy}
                      onClick={() => void confirmDelete(preset.id)}
                    >
                      {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                      {tc("paramPresets.deleteConfirm")}
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
