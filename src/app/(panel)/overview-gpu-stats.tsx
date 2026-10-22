"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { apiFetch } from "@/lib/api";
import type { GpuStatsPayload } from "@/server/metrics/latest";
import type { NvidiaStatus } from "@/server/metrics/nvidiaSmi";

const GpuStatsContext = createContext<(GpuStatsPayload & { failed: boolean }) | null>(null);

/** 左侧分卡显存与右侧合计共享一次秒级轮询。 */
export function OverviewGpuStatsProvider({
  initialStatus,
  children,
}: {
  initialStatus: NvidiaStatus;
  children: ReactNode;
}) {
  const [stats, setStats] = useState<GpuStatsPayload>({
    available: initialStatus === "available",
    status: initialStatus,
    samples: null,
    devices: [],
    totals: null,
  });
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const load = async () => {
      if (document.hidden || pending) return;
      pending = true;
      try {
        const response = await apiFetch("/api/v1/gpu/stats", { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("gpu stats http error");
        const payload = (await response.json()) as GpuStatsPayload;
        if (!controller.signal.aborted) {
          setStats(payload);
          setFailed(false);
        }
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      } finally {
        pending = false;
      }
    };
    const onVisibility = () => void load();
    const timer = setInterval(onVisibility, 1_000);
    void load();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      controller.abort();
    };
  }, []);

  return <GpuStatsContext value={{ ...stats, failed }}>{children}</GpuStatsContext>;
}

export function useOverviewGpuStats() {
  const stats = useContext(GpuStatsContext);
  if (stats === null) throw new Error("OverviewGpuStatsProvider is required");
  return stats;
}
