"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw, Square } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";

import { StartProgressDialog } from "./start-progress-dialog";

/**
 * 概览页运行状态卡的操作区（client，M1 Task 9）：停止 / 重启。
 * 停止调 POST /api/v1/models/:name/stop 完成后 router.refresh()；
 * 重启（UX P0 Task 8）改走 StartProgressDialog——重启同样要经历完整模型
 * 加载，值得同样的进度可见性（action="restart"，就绪判据走状态轮询）。
 *
 * "启动"不在此卡直接做——单模型语义下"未运行时启动哪个"未知（面板无状态），
 * M1 简化为跳模型列表选择（见 page.tsx 的引导文案）。
 */
export function RuntimeCardActions({
  modelName,
  displayName,
}: {
  modelName: string;
  displayName: string;
}) {
  const t = useTranslations("pages.overview");
  const router = useRouter();
  const [pending, setPending] = useState<"stop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restartOpen, setRestartOpen] = useState(false);

  async function stopModel() {
    setPending("stop");
    setError(null);
    try {
      const res = await apiFetch(`/api/v1/models/${modelName}/stop`, { method: "POST" });
      if (res.ok) {
        router.refresh();
        return;
      }
      setError(t("errorRequest"));
    } catch {
      setError(t("errorRequest"));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex w-full items-center gap-1.5">
        <Button
          variant="destructive"
          size="sm"
          className="flex-1"
          disabled={pending !== null}
          onClick={stopModel}
        >
          {pending === "stop" ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Square className="size-3.5" />
          )}
          {pending === "stop" ? t("actionStopping") : t("actionStop")}
        </Button>
        <Button variant="outline" size="sm" disabled={pending !== null} onClick={() => setRestartOpen(true)}>
          <RefreshCw className="size-3.5" />
          {t("actionRestart")}
        </Button>
      </div>
      {error && <p className="text-xs whitespace-normal text-destructive">{error}</p>}
      {restartOpen && (
        <StartProgressDialog
          onOpenChange={setRestartOpen}
          modelName={modelName}
          displayName={displayName}
          action="restart"
        />
      )}
    </div>
  );
}
