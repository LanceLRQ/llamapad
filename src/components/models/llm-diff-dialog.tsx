"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiFetch } from "@/lib/api";
import { toast } from "@/components/toast-store";
import type { RecommendedProfile } from "@/lib/readme-params";

/**
 * 重跑结果的覆盖确认（批 3）
 *
 * 首次解析直接落库，只有重跑才走到这里——那时用户手上已经有一份花过代价的
 * 结果，新的未必更好，得让他自己看着办。
 *
 * **落库不在这里发生**：点「覆盖」只是把模型输出的原始文本回传给
 * `/readme/llm/save`，服务端重跑一遍解析与回证再落。前端篡改也绕不过回证。
 */
export function LlmDiffDialog({ repoId, pending, previous, onResolved, onOpenChange }: {
  repoId: number;
  pending: { raw: string; engine: string; model: string; profiles: RecommendedProfile[] } | null;
  previous: RecommendedProfile[];
  /** 覆盖成功后把新结果交回面板 */
  onResolved: (profiles: RecommendedProfile[]) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("pages.repos");
  const [busy, setBusy] = useState(false);

  async function overwrite(): Promise<void> {
    if (pending === null || busy) return;
    setBusy(true);
    const res = await apiFetch(`/api/v1/repos/${repoId}/readme/llm/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ raw: pending.raw, engine: pending.engine, model: pending.model }),
    }).catch(() => null);
    setBusy(false);

    if (res === null || !res.ok) return void toast.error(t("llmSaveFailed"));
    onResolved(pending.profiles);
    onOpenChange(false);
    toast.success(t("llmSaveDone"));
  }

  return (
    <Dialog open={pending !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("llmDiffTitle")}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <ProfileColumn title={t("llmDiffOld")} profiles={previous} />
          <ProfileColumn title={t("llmDiffNew")} profiles={pending?.profiles ?? []} />
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {t("llmDiffKeepOld")}
          </Button>
          <Button disabled={busy} onClick={() => void overwrite()}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t("llmDiffOverwrite")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 一列摘要：每套推荐一行标题 + 字段键值，够用来做取舍判断，不必渲染整张卡 */
function ProfileColumn({ title, profiles }: { title: string; profiles: RecommendedProfile[] }) {
  const t = useTranslations("pages.repos");
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {profiles.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("llmDiffEmpty")}</p>
      ) : (
        profiles.map((profile) => (
          <div key={profile.id} className="rounded-md border p-2">
            <p className="text-xs font-medium">{profile.label === "" ? t("recommendUnnamed") : profile.label}</p>
            <ul className="mt-1 space-y-0.5">
              {Object.entries(profile.server).map(([field, value]) => (
                <li key={field} className="font-mono text-[11px] text-muted-foreground">
                  {field} {String(value)}
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </div>
  );
}
