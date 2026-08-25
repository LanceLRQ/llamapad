"use client";

import { useSyncExternalStore } from "react";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { toastStore, type ToastItem, type ToastVariant } from "./toast-store";

/**
 * 全局 toast 渲染层（UX P0 Task 1 / U1）：根 layout 挂一次，消费 toast-store
 * 单例。命令式调用见 `toast.success/error/info`（toast-store.ts）——文案由调用方
 * 用 next-intl 翻译后传入，本组件不介入 i18n。
 *
 * 定位右下角（避开顶部导航与居中对话框）；容器 pointer-events-none、卡片
 * 自身恢复事件（可点关闭）。无入场动画（P0 最小实现，优先稳态可读）。
 */

const VARIANT_STYLES: Record<ToastVariant, string> = {
  success: "border-accent-green/25 bg-accent-green/10 text-accent-green",
  error: "border-destructive/25 bg-destructive/10 text-destructive",
  info: "border-primary/25 bg-primary/10 text-primary",
};

const VARIANT_ICONS: Record<ToastVariant, typeof Info> = {
  success: CircleCheck,
  error: CircleAlert,
  info: Info,
};

function ToastCard({ item }: { item: ToastItem }) {
  const Icon = VARIANT_ICONS[item.variant];
  return (
    <div
      role="status"
      className={cn(
        "pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2.5 shadow-md",
        VARIANT_STYLES[item.variant],
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <p className="min-w-0 flex-1 text-xs leading-relaxed whitespace-normal break-words">
        {item.message}
      </p>
      <button
        type="button"
        aria-label="dismiss"
        className="shrink-0 rounded p-0.5 opacity-60 hover:opacity-100"
        onClick={() => toastStore.dismiss(item.id)}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

export function Toaster() {
  const items = useSyncExternalStore(
    toastStore.subscribe,
    toastStore.getSnapshot,
    toastStore.getServerSnapshot,
  );

  if (items.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
    >
      {items.map((item) => (
        <ToastCard key={item.id} item={item} />
      ))}
    </div>
  );
}
