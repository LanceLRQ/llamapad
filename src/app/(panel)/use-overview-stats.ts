"use client";

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "@/lib/api";
import { useRefreshInterval } from "@/lib/use-refresh-interval";
import {
  type ContainerStatsPayload,
  type GpuStatsPayload,
  type HostStatsPayload,
  type LatestSample,
} from "@/server/metrics/latest";
import type { GpuDevice, NvidiaStatus } from "@/server/metrics/nvidiaSmi";

/**
 * 概览合卡「当前值」轮询 hook（任务 13 从 monitoring/metric-cards.tsx 的
 * loadStats 提出）：container/gpu/host 三路 stats 接口一次轮询取回卡头的
 * 大数字与分母原料，节拍复用页面已有的 RefreshIntervalSelect——intervalMs
 * 是模块级 store（见 lib/use-refresh-interval.ts 头注释），本 hook 与
 * use-overview-window.ts 各自订阅同一份间隔，互不知晓对方存在，页面上
 * 只会挂出一个选择器组件，不会因为拆了两个 hook 就多出第二个 UI。
 *
 * GPU 三态判据与原 metric-cards.tsx 同构：探测中（probing）与确认不可用
 * （unavailable）都不返回可用样本，只吐 gpuStatus 交给调用方决定隐藏哪些
 * 卡 / 是否渲染提示条——hook 本身不背 UI 判断。
 *
 * 与窗口轮询（use-overview-window.ts）的分工：那边管图表历史，节拍随
 * range 档位在 5s~60s 间切换；这里管"当前值"，语义上与 range 无关（哪怕
 * 用户在看 7d 档的历史图，卡头大数字仍应是最新一刻的读数），因此恒以
 * intervalMs 轮询，不受 range 影响——原窗口轮询里"顺带"刷新 gpuStatus 的
 * 那次 piggyback 请求也随之收敛到这里，不再有两处各发一次 /api/v1/gpu/stats。
 */
export interface OverviewStats {
  containerStats: ContainerStatsPayload | null;
  gpuStatus: NvidiaStatus;
  gpuSamples: { [metric: string]: LatestSample } | null;
  gpuDevices: GpuDevice[];
  gpuTotals: { memUsedMib: number; memTotalMib: number } | null;
  hostStats: HostStatsPayload | null;
  failed: boolean;
}

export function useOverviewStats(initialGpuStatus: NvidiaStatus): OverviewStats {
  const { intervalMs } = useRefreshInterval();
  const [containerStats, setContainerStats] = useState<ContainerStatsPayload | null>(null);
  const [gpuStatus, setGpuStatus] = useState<NvidiaStatus>(initialGpuStatus);
  const [gpuSamples, setGpuSamples] = useState<{ [metric: string]: LatestSample } | null>(
    initialGpuStatus === "available" ? {} : null,
  );
  const [gpuDevices, setGpuDevices] = useState<GpuDevice[]>([]);
  const [gpuTotals, setGpuTotals] = useState<{ memUsedMib: number; memTotalMib: number } | null>(
    null,
  );
  const [hostStats, setHostStats] = useState<HostStatsPayload | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [container, gpu, host] = await Promise.all([
        apiFetch("/api/v1/container/stats", { signal, cache: "no-store" }),
        apiFetch("/api/v1/gpu/stats", { signal, cache: "no-store" }),
        apiFetch("/api/v1/host/stats", { signal, cache: "no-store" }),
      ]);
      if (!container.ok || !gpu.ok || !host.ok) throw new Error("stats http error");
      setContainerStats((await container.json()) as ContainerStatsPayload);
      const gpuPayload = (await gpu.json()) as GpuStatsPayload;
      setGpuStatus(gpuPayload.status);
      setGpuSamples(gpuPayload.samples ?? {});
      setGpuDevices(gpuPayload.devices);
      setGpuTotals(gpuPayload.totals);
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

  return { containerStats, gpuStatus, gpuSamples, gpuDevices, gpuTotals, hostStats, failed };
}
