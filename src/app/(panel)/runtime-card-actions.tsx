"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw, Square } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";

/**
 * 概览页运行状态卡的操作区（client，M1 Task 9）：停止 / 重启。
 * 调 POST /api/v1/models/:name/{stop,restart}，完成后 router.refresh()
 * 重取 page 数据（与模型列表行操作同一实时性策略：动作触发刷新，不轮询）。
 *
 * "启动"不在此卡直接做——单模型语义下"未运行时启动哪个"未知（面板无状态），
 * M1 简化为跳模型列表选择（见 page.tsx 的引导文案）。
 */
export function RuntimeCardActions({ modelName }: { modelName: string }) {
  const t = useTranslations("pages.overview");
  const router = useRouter();
  const [pending, setPending] = useState<"stop" | "restart" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runAction(action: "stop" | "restart") {
    setPending(action);
    setError(null);
    try {
      const res = await apiFetch(`/api/v1/models/${modelName}/${action}`, { method: "POST" });
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
          onClick={() => runAction("stop")}
        >
          {pending === "stop" ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Square className="size-3.5" />
          )}
          {pending === "stop" ? t("actionStopping") : t("actionStop")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={pending !== null}
          onClick={() => runAction("restart")}
        >
          {pending === "restart" ? (
            <Loader2 className="animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          {pending === "restart" ? t("actionRestarting") : t("actionRestart")}
        </Button>
      </div>
      {error && <p className="text-xs whitespace-normal text-destructive">{error}</p>}
    </div>
  );
}
