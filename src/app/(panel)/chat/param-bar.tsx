"use client";

import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { compareSampling, SAMPLING_ROWS, type DriftRow, type SamplingConfig } from "@/lib/props-drift";

/** 弹层未发过消息时的占位预览：纯示意字符串，不是真的 JSON.stringify 结果 */
const REQUEST_BODY_PLACEHOLDER = '{"messages": [...], "stream": true}';

/**
 * Playground 只读参数栏（自建 Playground 任务 6）：把面板的启动参数
 * （config，传给 llama-server 的 --temp/--top-p 等）与 /props 回读的实际生效值
 * 做比对。两者不一致说明容器不是用当前配置起的——这是本面板相对 llama.cpp
 * 自带 Web UI 的核心差异化，后者不知道面板配了什么。
 *
 * 叶子组件：config/ctxSize/lastBody 均由父组件（ChatPanel）传入，不在此自取。
 */
export function ParamBar({
  config,
  ctxSize,
  lastBody,
}: {
  config: SamplingConfig;
  ctxSize: number;
  lastBody: unknown;
}) {
  const t = useTranslations("pages.chat");
  const [rows, setRows] = useState<DriftRow[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await apiFetch("/api/v1/proxy/llama/props", {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!res.ok) return;
        const props = (await res.json()) as {
          default_generation_settings?: { params?: Record<string, unknown> };
        };
        setRows(compareSampling(config, props.default_generation_settings?.params ?? {}));
      } catch {
        // 取不到 /props 就只展示配置值，不报错——参数栏是辅助信息不是主功能
      }
    })();
    return () => controller.abort();
  }, [config]);

  const hasDrift = rows?.some((row) => row.drift) ?? false;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="outline" className="h-auto gap-1.5 py-1 text-xs text-foreground">
        {SAMPLING_ROWS.map(({ key }, index) => {
          // rows 未就绪（尚未取到 /props，或取数失败）时照常展示配置值，只是不做漂移标记
          const row = rows?.find((r) => r.key === key) ?? null;
          const value = row ? row.configured : config[key];
          const drift = row?.drift ?? false;
          return (
            <span key={key} className="flex items-center gap-1.5">
              {index > 0 && <span className="text-muted-foreground">·</span>}
              <span className="text-muted-foreground">{key}</span>
              <span
                className={cn(
                  "font-mono tabular-nums",
                  drift && "text-amber-600 dark:text-amber-400",
                )}
                title={drift ? `${t("driftHint")}（实际 ${row!.actual}）` : undefined}
              >
                {value}
              </span>
              {drift && <TriangleAlert className="size-2.5 text-amber-600 dark:text-amber-400" />}
            </span>
          );
        })}
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">ctx</span>
        <span className="font-mono tabular-nums">{ctxSize}</span>
      </Badge>

      {hasDrift && (
        <Badge
          variant="outline"
          className="gap-1 border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
        >
          <TriangleAlert className="size-2.5!" />
          {t("driftHint")}
        </Badge>
      )}

      <Button
        variant="ghost"
        size="xs"
        className="ml-auto text-muted-foreground"
        onClick={() => setOpen(true)}
      >
        {t("viewRequestBody")}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("viewRequestBody")}</DialogTitle>
          </DialogHeader>
          <pre className="max-h-96 overflow-x-auto overflow-y-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap break-words">
            {lastBody === null ? REQUEST_BODY_PLACEHOLDER : JSON.stringify(lastBody, null, 2)}
          </pre>
          {lastBody === null && (
            <p className="text-xs text-muted-foreground">{t("requestBodyEmpty")}</p>
          )}
          <p className="text-xs text-muted-foreground">{t("requestBodyNote")}</p>
        </DialogContent>
      </Dialog>
    </div>
  );
}
