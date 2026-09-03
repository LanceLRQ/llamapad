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
  /** 覆盖成功后把新结果交回面板：三个值全部取自服务端重跑回证之后的响应
   *  （profiles/offered/dropped）与本次覆盖使用的模型名，不是 `pending` 里
   *  客户端手上那份——README 若在这次请求期间变了，服务端用新 body 回证
   *  出来的结果可能比客户端展示的更少，前端必须展示落库的那份，不能展示
   *  用户刚才在弹层里看到的那份 */
  onResolved: (profiles: RecommendedProfile[], stats: { offered: number; dropped: number }, model: string) => void;
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
    const body = (await res.json().catch(() => null)) as
      | { ok: true; profiles: RecommendedProfile[]; offered: number; dropped: number }
      | null;
    if (body === null) return void toast.error(t("llmSaveFailed"));
    onResolved(body.profiles, { offered: body.offered, dropped: body.dropped }, pending.model);
    onOpenChange(false);
    toast.success(t("llmSaveDone"));
  }

  return (
    <Dialog open={pending !== null} onOpenChange={onOpenChange}>
      {/* 默认的 sm:max-w-sm 太窄：两列摘要各只剩不到 200px，标题必折行、
          参数纵向排开会把弹层拉得比屏幕还高。加宽到 3xl 并给列表内部滚动，
          让「保留旧的 / 覆盖」两个按钮始终留在视口里 */}
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("llmDiffTitle")}</DialogTitle>
        </DialogHeader>
        <div className="grid max-h-[60vh] gap-4 overflow-y-auto sm:grid-cols-2">
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
        // 虚线占位而不是一行小字：两列并排时，空列若只有一行字会在大片留白
        // 顶端孤零零挂着，看不出「这一列确实是空的」还是「没渲染出来」
        <div className="rounded-md border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
          {t("llmDiffEmpty")}
        </div>
      ) : (
        profiles.map((profile) => (
          <div key={profile.id} className="rounded-md border p-3">
            <p className="text-xs leading-snug font-medium">
              {profile.label === "" ? t("recommendUnnamed") : profile.label}
            </p>
            {/* 两列铺参数：一套推荐常有 6 个字段，纵向排开会让每张卡高得离谱 */}
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
              {Object.entries(profile.server).map(([field, value]) => (
                <div key={field} className="flex items-baseline gap-1.5 font-mono text-[11px]">
                  <dt className="truncate text-muted-foreground">{field}</dt>
                  <dd className="ml-auto font-medium">{String(value)}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))
      )}
    </div>
  );
}
