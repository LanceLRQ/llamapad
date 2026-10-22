"use client";

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "@/lib/api";
import { useRefreshInterval } from "@/lib/use-refresh-interval";
import {
  type ContainerStatsPayload,
  type HostStatsPayload,
  type LatestSample,
} from "@/server/metrics/latest";
import type { NvidiaStatus } from "@/server/metrics/nvidiaSmi";
import { useOverviewGpuStats } from "./overview-gpu-stats";

/**
 * 概览合卡「当前值」轮询 hook（任务 13 从 monitoring/metric-cards.tsx 的
 * loadStats 提出）：container/host 两路 stats 接口一次轮询取回卡头的
 * 大数字与分母原料，节拍复用页面已有的 RefreshIntervalSelect——intervalMs
 * 是模块级 store（见 lib/use-refresh-interval.ts 头注释），本 hook 与
 * use-overview-window.ts 各自订阅同一份间隔，互不知晓对方存在，页面上
 * 只会挂出一个选择器组件，不会因为拆了两个 hook 就多出第二个 UI。
 *
 * GPU 数据由 OverviewGpuStatsProvider 秒级轮询，左右两列共享同一份快照。
 *
 * 与窗口轮询（use-overview-window.ts）的分工：那边管图表历史，节拍随
 * range 档位在 5s~60s 间切换；这里管"当前值"，语义上与 range 无关（哪怕
 * 用户在看 7d 档的历史图，卡头大数字仍应是最新一刻的读数），因此恒以
 * intervalMs 轮询，不受 range 影响。GPU 独立按秒刷新，不受图表档位影响。
 */
export interface OverviewStats {
  containerStats: ContainerStatsPayload | null;
  gpuStatus: NvidiaStatus;
  gpuSamples: { [metric: string]: LatestSample } | null;
  hostStats: HostStatsPayload | null;
  failed: boolean;
}

export function useOverviewStats(): OverviewStats {
  const { intervalMs } = useRefreshInterval();
  const gpu = useOverviewGpuStats();
  const [containerStats, setContainerStats] = useState<ContainerStatsPayload | null>(null);
  const [hostStats, setHostStats] = useState<HostStatsPayload | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [container, host] = await Promise.all([
        apiFetch("/api/v1/container/stats", { signal, cache: "no-store" }),
        apiFetch("/api/v1/host/stats", { signal, cache: "no-store" }),
      ]);
      if (!container.ok || !host.ok) throw new Error("stats http error");
      setContainerStats((await container.json()) as ContainerStatsPayload);
      setHostStats((await host.json()) as HostStatsPayload);
      setFailed(false);
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        return;
      }
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const tick = () => {
      if (!document.hidden) void load(controller.signal);
    };
    const timer = setInterval(tick, intervalMs);
    tick(); // 初次加载
    const onVisibility = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      controller.abort();
    };
  }, [load, intervalMs]);

  return {
    containerStats,
    gpuStatus: gpu.status,
    gpuSamples: gpu.samples,
    hostStats,
    failed: failed || gpu.failed,
  };
}
