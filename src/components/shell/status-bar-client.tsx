"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Unplug } from "lucide-react";
import { useTranslations } from "next-intl";

import { DownloadsBadge } from "@/components/shell/downloads-badge";
import { LocaleToggle } from "@/components/locale-toggle";
import { ThemeToggle } from "@/components/theme-toggle";
import { toast } from "@/components/toast-store";
import { apiFetch } from "@/lib/api";
import { connectionStore } from "@/lib/connection-store";
import {
  STATUS_BAR_ITEM_CLASS,
  type GaugeReadout,
  type GaugeTone,
  formatCpuGauge,
  formatDiskGauge,
  formatGpuGauge,
  formatMemGauge,
  formatPort,
  gaugeTone,
} from "@/lib/status-bar";
import { cn } from "@/lib/utils";
import { METRIC_IDS } from "@/server/metrics/ids";
import type { GpuStatsPayload, HostStatsPayload } from "@/server/metrics/latest";

/**
 * 状态栏 client 内件（M16 T1）：下载进展 · CPU/内存/GPU/磁盘四项计量轮询 ·
 * 离线态 · 主题/语言切换。运行模型 chip 由 server 侧的 status-bar.tsx 传
 * `running` prop 进来——它随页面导航更新，不在此处轮询（与旧顶栏取舍一致）。
 *
 * 离线接线（原旧顶栏外的离线横幅并入）：判定源见 connection-store——
 * apiFetch 连续网络失败（面板重启/反代断开，navigator.onLine 仍 true）+
 * 浏览器 offline 事件（本组件接线）。恢复时整条状态栏变回常态并补一条 toast
 * （用户可能正盯着别的页面区域）。
 *
 * 四项计量（CPU/内存/GPU/磁盘）轮询固定 10s（不复用监控页
 * useRefreshInterval——那是用户可选节拍，状态栏是常驻信息，不需要可调）：
 * document.hidden 时跳过，visibilitychange 回到可见立即补拉一次。任一接口
 * 失败都不弹 toast，静默保留上一次读数（读数缺失才显示 —，由各 gauge
 * 格式化器兜底）。
 */

const POLL_MS = 10_000;

interface RunningInfo {
  displayName: string;
  /** 容器名，只用于拼 chip 的悬浮 title（"当前运行模型 · 容器名"），不内联展示 */
  container: string;
  hostPort: number | null;
}

export function StatusBarClient({ running }: { running: RunningInfo | null }) {
  const t = useTranslations("statusbar");
  const tCommon = useTranslations("common");

  // ---- 离线态（原旧顶栏外的离线横幅并入）----
  const connState = useSyncExternalStore(
    connectionStore.subscribe,
    connectionStore.getSnapshot,
    connectionStore.getServerSnapshot,
  );
  const previousConn = useRef(connState);
  const offline = connState === "offline";

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

  // 离线 → 在线迁移时提示恢复（在线 → 离线由状态栏本体变红表达，不再叠加 toast）
  useEffect(() => {
    if (previousConn.current === "offline" && connState === "online") {
      toast.success(tCommon("connectionRestored"));
    }
    previousConn.current = connState;
  }, [connState, tCommon]);

  // ---- CPU / 内存 / GPU / 磁盘轮询 ----
  const [gpuStats, setGpuStats] = useState<GpuStatsPayload | null>(null);
  const [hostStats, setHostStats] = useState<HostStatsPayload | null>(null);

  const loadStats = useCallback(async (signal?: AbortSignal) => {
    try {
      const [gpuRes, hostRes] = await Promise.all([
        apiFetch("/api/v1/gpu/stats", { signal, cache: "no-store" }),
        apiFetch("/api/v1/host/stats", { signal, cache: "no-store" }),
      ]);
      if (gpuRes.ok) setGpuStats((await gpuRes.json()) as GpuStatsPayload);
      if (hostRes.ok) setHostStats((await hostRes.json()) as HostStatsPayload);
    } catch {
      // 静默：网络异常/请求被中止都不弹 toast，读数保留上一帧
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const tick = () => {
      if (!document.hidden) void loadStats(controller.signal);
    };
    const timer = setInterval(tick, POLL_MS);
    tick();
    const onVisibility = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      controller.abort();
    };
  }, [loadStats]);

  const cpuGauge = formatCpuGauge(hostStats?.samples ?? {}, hostStats?.hostCpuCount ?? null, {
    cores: t("cpuCoresUnit"),
    load: t("cpuLoadLabel"),
  });
  const memGauge = formatMemGauge(hostStats?.samples ?? {}, hostStats?.hostMemTotalBytes ?? null);
  const gpuGauge = formatGpuGauge(gpuStats?.totals ?? null, gpuStats?.samples ?? null, {
    vram: t("gpuVramLabel"),
    util: t("gpuUtilLabel"),
  });
  const diskGauge = formatDiskGauge(
    hostStats?.samples[METRIC_IDS.hostDiskFreeBytes]?.value ?? null,
    hostStats?.hostDiskTotalBytes ?? null,
  );
  const portSuffix = formatPort(running?.hostPort ?? null);

  return (
    <footer
      className={cn(
        // 左 16px（给运行 chip 留呼吸位）、右 12px（贴框边即可，两侧不对称是设计稿定的）
        "col-span-2 flex h-[30px] min-h-0 items-center gap-1 border-t bg-muted pl-4 pr-3 font-mono text-[11.5px] text-muted-foreground",
        offline && "border-destructive/20 bg-destructive/5 text-destructive",
      )}
    >
      {offline && (
        <span
          title={tCommon("connectionLost")}
          className={cn(STATUS_BAR_ITEM_CLASS, "gap-1.5 text-destructive")}
        >
          <Unplug className="size-3" />
          {t("offline")}
        </span>
      )}

      {/* 运行模型 chip：绿点 + 3px 同色光环 + 展示名加粗 + 端口后缀弱化；
          title 只在运行时挂"当前运行模型 · 容器名"，未运行没有容器名可挂 */}
      <span
        title={running ? `${t("runningTitle")} · ${running.container}` : undefined}
        className={cn(STATUS_BAR_ITEM_CLASS, "gap-1.5")}
      >
        {running ? (
          <>
            <span className="size-1.5 rounded-full bg-accent-green ring-[3px] ring-accent-green/20" />
            <span className="font-semibold text-foreground">{running.displayName}</span>
            {portSuffix && <span className="opacity-62">{portSuffix}</span>}
          </>
        ) : (
          <>
            <span className="size-1.5 rounded-full bg-muted-foreground/50" />
            {t("statusIdle")}
          </>
        )}
      </span>

      <DownloadsBadge />

      <div className="flex-1" />

      {/* 条 = 占用率，精确数值（用量/总量、利用率、负载）都收进悬浮 title——
          裸数字要心算才知道占了多少，条形一眼就能看出"还剩多少"（能不能再起
          一个模型）。CPU/内存窄屏收起，GPU/磁盘是本面板主角，始终显示 */}
      <GaugeItem label={t("cpuLabel")} title={t("cpuTitle")} gauge={cpuGauge} className="hidden lg:flex" />
      <GaugeItem label={t("memLabel")} title={t("memTitle")} gauge={memGauge} className="hidden lg:flex" />
      <GaugeItem label={t("gpuLabel")} title={t("gpuTitle")} gauge={gpuGauge} />
      <GaugeItem label={t("diskLabel")} title={t("diskTitle")} gauge={diskGauge} />

      <span className="mx-1 h-[14px] w-px bg-border" />

      <ThemeToggle compact />
      <LocaleToggle compact />

      {/* 面板版本号：原侧栏品牌行右侧的展示位，折叠侧栏后无处安放，
          挪到状态栏最右端（次要信息，弱化透明度不与其他计量抢视觉权重） */}
      <span title={t("versionTitle")} className={cn(STATUS_BAR_ITEM_CLASS, "opacity-62")}>
        v{process.env.NEXT_PUBLIC_APP_VERSION}
      </span>
    </footer>
  );
}

/** 条形色阶 → 填充色类名（normal 用 muted-foreground，够看清又不抢眼） */
const TONE_CLASS: Record<GaugeTone, string> = {
  normal: "bg-muted-foreground",
  warn: "bg-primary",
  critical: "bg-accent-red",
};

/**
 * 状态栏计量条目：标签 + 22×5px 轨道 + 加粗百分比。
 * percent 为 null（该项未采到）时不画轨道——空轨道会被误读成"占用 0%"。
 */
function GaugeItem({
  label,
  title,
  gauge,
  className,
}: {
  label: string;
  title: string;
  gauge: GaugeReadout;
  className?: string;
}) {
  return (
    <span
      title={gauge.detail !== null ? `${title} · ${gauge.detail}` : title}
      className={cn(STATUS_BAR_ITEM_CLASS, "gap-1.5", className)}
    >
      {label}
      {gauge.percent !== null && (
        <span className="h-[5px] w-[22px] overflow-hidden rounded-full bg-foreground/12">
          <span
            className={cn(
              "block h-full rounded-full transition-[width] duration-500",
              TONE_CLASS[gaugeTone(gauge.percent)],
            )}
            style={{ width: `${gauge.percent}%` }}
          />
        </span>
      )}
      <span className="font-semibold text-foreground">{gauge.text}</span>
    </span>
  );
}
