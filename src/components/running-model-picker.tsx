"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiFetch } from "@/lib/api";
import {
  FOLLOW_DEFAULT,
  summarizeRunningModels,
  type ModelPickerOption,
  type RunningModelSummary,
} from "@/lib/model-picker";

/** 列表轮询间隔：只影响「别处启停的模型多久出现在下拉框里」，不必跟启动弹窗一样 2s */
const POLL_MS = 5_000;

export interface RunningModelsSnapshot {
  models: RunningModelSummary[];
  defaultModel: string | null;
}

/**
 * 运行中模型列表（Chat 页与日志页页头的下拉框共用）：服务端渲染给初值，之后每 5s 拉一次
 * /api/v1/runtime/status，让别的标签页里启停的模型也能反映到下拉框。节拍（隐藏时暂停、
 * 回到可见立即补拉）与 chat/chat-loading.tsx 同款；初值刚由服务端算出，挂载时不立即拉。
 *
 * synced：第一次轮询成功后为 true。调用方判断「选中的模型已停止」必须等它——初值与页面
 * 同源，拿初值判等于自己和自己比。调用方以选中的模型为 key 挂载本 hook 所在组件，
 * 切换模型或 router.refresh() 换了模型时整体重建，初值不会陈旧。
 */
export function useRunningModels(initial: RunningModelsSnapshot): RunningModelsSnapshot & { synced: boolean } {
  const [snapshot, setSnapshot] = useState(initial);
  const [synced, setSynced] = useState(false);

  const poll = useCallback(async (signal: AbortSignal) => {
    try {
      const res = await apiFetch("/api/v1/runtime/status", { signal, cache: "no-store" });
      if (!res.ok) return;
      const status = (await res.json()) as RunningModelsSnapshot;
      setSnapshot({ models: summarizeRunningModels(status.models), defaultModel: status.defaultModel });
      setSynced(true);
    } catch {
      // 轮询失败静默：断线提示由状态栏承担，下拉框保留上一份列表
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const tick = () => {
      if (!document.hidden) void poll(controller.signal);
    };
    const timer = setInterval(tick, POLL_MS);
    const onVisibility = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      controller.abort();
    };
  }, [poll]);

  return { ...snapshot, synced };
}

/**
 * 页头模型下拉框。选项与显示条件由 lib/model-picker.ts 算好传进来，本组件只负责渲染。
 * followDefault 为 true 时在最前面加一项「跟随默认模型」（值为 FOLLOW_DEFAULT，日志页用）。
 */
export function RunningModelPicker({
  options,
  value,
  onChange,
  followDefault = false,
}: {
  options: ModelPickerOption[];
  value: string;
  onChange: (value: string) => void;
  followDefault?: boolean;
}) {
  const t = useTranslations("common.modelPicker");
  const labelOf = (v: string) =>
    v === FOLLOW_DEFAULT ? t("followDefault") : (options.find((option) => option.value === v)?.label ?? v);

  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next !== null && String(next) !== value) onChange(String(next));
      }}
    >
      <SelectTrigger size="sm" className="max-w-64 min-w-40" aria-label={t("ariaLabel")}>
        <SelectValue>{(v: string) => labelOf(v)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {followDefault && <SelectItem value={FOLLOW_DEFAULT}>{t("followDefault")}</SelectItem>}
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            <span className="truncate">{option.label}</span>
            {option.isDefault && <span className="text-xs text-muted-foreground">{t("default")}</span>}
            {option.loading && <span className="text-xs text-muted-foreground">{t("loading")}</span>}
            {option.stopped && <span className="text-xs text-muted-foreground">{t("stopped")}</span>}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
