"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

import { refreshIntervalStore, type RefreshIntervalMs } from "./refresh-interval";

/**
 * 刷新间隔选择器 hook：监控页与概览图表页各自独立挂载选择器组件，靠共享
 * refresh-interval.ts 的模块级 store 联动——改一处，另一处的订阅自动重渲染，
 * 两个组件互不知晓对方存在。
 *
 * SSR/hydration 安全：useSyncExternalStore 的 getServerSnapshot 恒为默认值，
 * 首帧（含首次客户端渲染）都用它，避免服务端无 window 读不到真实值造成
 * hydration mismatch；真实值在挂载后的 effect 里经 store.hydrate() 读出
 * 并切换（hydrate 本身幂等，多个选择器同时挂载只会真正读一次 localStorage）。
 */
export function useRefreshInterval(): {
  intervalMs: RefreshIntervalMs;
  setIntervalMs: (value: RefreshIntervalMs) => void;
} {
  const intervalMs = useSyncExternalStore(
    refreshIntervalStore.subscribe,
    refreshIntervalStore.getSnapshot,
    refreshIntervalStore.getServerSnapshot,
  );

  useEffect(() => {
    refreshIntervalStore.hydrate();
  }, []);

  const setIntervalMs = useCallback((value: RefreshIntervalMs) => {
    refreshIntervalStore.setValue(value);
  }, []);

  return { intervalMs, setIntervalMs };
}
