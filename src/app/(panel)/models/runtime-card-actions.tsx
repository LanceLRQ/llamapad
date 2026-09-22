"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw, Square, Star } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";

import { StartProgressDialog } from "../start-progress-dialog";

/**
 * 运行状态卡里单个模型的操作区（client，M1 Task 9）：停止 / 重启 / 设为默认。
 * 停止调 POST /api/v1/models/:name/stop，设为默认调 PUT /api/v1/runtime/default-model，
 * 完成后 router.refresh()；重启（UX P0 Task 8）走 StartProgressDialog——重启同样要经历
 * 完整模型加载，值得同样的进度可见性（action="restart"，就绪判据走状态轮询）。
 *
 * "启动"不在此卡直接做：未运行的模型在模型列表里启动。
 * 「设为默认」只在有多个模型运行时出现（showSetDefault），只有一个时它必然是默认。
 *
 * 组件已随唯一调用方（home-running.tsx）从概览页迁入 models/（2026-09-21 首页
 * 迁移）：概览页那张卡已精简为两行摘要，这个操作区搬到了模型首页「正在运行」区。
 * 文案暂留 `pages.overview` 命名空间未迁——迁键会牵连整批已有翻译且不影响行为，
 * 留到下次真正需要动这批文案时再一并处理。
 */
export function RuntimeCardActions({
  modelName,
  displayName,
  isDefault,
  showSetDefault,
}: {
  modelName: string;
  displayName: string;
  isDefault: boolean;
  showSetDefault: boolean;
}) {
  const t = useTranslations("pages.overview");
  const router = useRouter();
  const [pending, setPending] = useState<"stop" | "default" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restartOpen, setRestartOpen] = useState(false);

  async function runRequest(kind: "stop" | "default", request: () => Promise<Response>) {
    setPending(kind);
    setError(null);
    try {
      const res = await request();
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

  const stopModel = () =>
    runRequest("stop", () => apiFetch(`/api/v1/models/${modelName}/stop`, { method: "POST" }));

  const setDefault = () =>
    runRequest("default", () =>
      apiFetch("/api/v1/runtime/default-model", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelName }),
      }),
    );

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
        {showSetDefault && !isDefault && (
          <Button variant="outline" size="sm" disabled={pending !== null} onClick={setDefault}>
            {pending === "default" ? <Loader2 className="animate-spin" /> : <Star className="size-3.5" />}
            {t("actionSetDefault")}
          </Button>
        )}
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
