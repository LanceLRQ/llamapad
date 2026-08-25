"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { Unplug } from "lucide-react";
import { useTranslations } from "next-intl";

import { toast } from "@/components/toast-store";
import { connectionStore } from "@/lib/connection-store";

/**
 * 全局连接状态横幅（UX P0 Task 3 / U10）：面板 layout 顶部挂一次。
 *
 * 判定源见 connection-store：apiFetch 连续网络失败（面板重启 / 反代断开，
 * navigator.onLine 仍 true）+ 浏览器 offline 事件（本组件接线）。恢复时
 * 自动隐藏并补一条 toast（用户可能正盯着别的页面区域）。
 */
export function ConnectionBanner() {
  const t = useTranslations("common");
  const state = useSyncExternalStore(
    connectionStore.subscribe,
    connectionStore.getSnapshot,
    connectionStore.getServerSnapshot,
  );
  const previous = useRef(state);

  // 浏览器整机断网/恢复接线（网络层信号由 apiFetch 喂，两者互补）
  useEffect(() => {
    const goOffline = () => connectionStore.reportBrowserOffline();
    const goOnline = () => connectionStore.reportRequestSuccess();
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
    };
  }, []);

  // 离线 → 在线迁移时提示恢复（在线 → 离线由横幅本体表达，不再叠加 toast）
  useEffect(() => {
    if (previous.current === "offline" && state === "online") {
      toast.success(t("connectionRestored"));
    }
    previous.current = state;
  }, [state, t]);

  if (state !== "offline") return null;

  return (
    <div
      role="alert"
      className="flex w-full items-center justify-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-xs font-medium text-amber-600 dark:text-amber-400"
    >
      <Unplug className="size-3.5" />
      {t("connectionLost")}
    </div>
  );
}
