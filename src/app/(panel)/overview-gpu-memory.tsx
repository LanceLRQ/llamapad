"use client";

import { Zap } from "lucide-react";
import { useTranslations } from "next-intl";

import { Card, CardContent } from "@/components/ui/card";
import { gpuMemoryPercent } from "@/lib/gpu-device-picker";
import { formatMib, gpuMaxTempC, gpuMemMain, gpuMemPercentText, gpuTotalPowerW, toGib } from "@/lib/metric-card-value";
import { gaugeTone } from "@/lib/status-bar";
import { METRIC_IDS } from "@/server/metrics/ids";
import { useOverviewGpuStats } from "./overview-gpu-stats";

export function OverviewGpuMemoryCard() {
  const t = useTranslations("pages.overview");
  const { status, devices, failed } = useOverviewGpuStats();
  if (status !== "available") return null;

  return (
    <Card>
      <CardContent>
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs font-semibold">
            <Zap className="size-3.5 text-muted-foreground" />
            {t("chartsGpuMemTitle")}
          </span>
          {devices.length > 0 && <span className="text-xs text-muted-foreground">{t("gpuDeviceCount", { count: devices.length })}</span>}
        </div>
        {failed && <p className="mt-1 text-xs text-destructive">{t("chartsLoadError")}</p>}
        {devices.length === 0 ? (
          <div className="mt-2 flex h-36 items-center justify-center text-xs text-muted-foreground">
            {t("chartsEmpty")}
          </div>
        ) : (
          <ul
            className="mt-3 max-h-48 space-y-3 overflow-y-auto pr-1"
            aria-label={t("chartsGpuMemTitle")}
            tabIndex={devices.length > 4 ? 0 : undefined}
          >
            {[...devices].sort((a, b) => a.index - b.index).map((device) => {
              const percent = gpuMemoryPercent(device.memUsedMib, device.memTotalMib);
              const tone = gaugeTone(percent);
              return (
                <li key={device.index} className="space-y-1.5">
                  <div className="flex min-w-0 items-center gap-2 text-xs">
                    <span className="shrink-0 font-mono font-medium">GPU {device.index}</span>
                    {device.name && <span className="truncate text-muted-foreground" title={device.name}>{device.name}</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 min-w-6 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                      {device.memTotalMib > 0 && (
                        <div
                          className={`h-full rounded-full transition-[width] duration-500 ${tone === "critical" ? "bg-accent-red" : tone === "warn" ? "bg-primary" : "bg-chart-1"}`}
                          style={{ width: `${percent}%` }}
                        />
                      )}
                    </div>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                      {toGib(device.memUsedMib)} / {device.memTotalMib > 0 ? toGib(device.memTotalMib) : "—"} GiB
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function OverviewGpuTotalsCard() {
  const t = useTranslations("pages.overview");
  const { status, devices, totals, samples, failed } = useOverviewGpuStats();
  if (status !== "available") return null;

  const hasTotal = totals !== null && totals.memTotalMib > 0;
  const memory = samples?.[METRIC_IDS.gpuMemUsedMib];
  const main = hasTotal
    ? gpuMemMain(totals.memUsedMib, totals.memTotalMib)
    : memory !== undefined ? formatMib(memory.value) : null;
  const percent = hasTotal ? gpuMemoryPercent(totals.memUsedMib, totals.memTotalMib) : null;
  const maxTemp = gpuMaxTempC(devices.flatMap((device) => device.tempC === null ? [] : [device.tempC]));
  const power = gpuTotalPowerW(devices.flatMap((device) => device.powerW === null ? [] : [device.powerW]));
  const details = [
    hasTotal ? gpuMemPercentText(totals.memUsedMib, totals.memTotalMib) : null,
    maxTemp === null ? null : `${maxTemp}°C`,
    power === null ? null : `${power}W`,
  ].filter((value) => value !== null);

  return (
    <Card className="lg:shrink-0">
      <CardContent>
        <div className="flex items-center gap-2">
          <Zap className="size-3.5 text-muted-foreground" />
          <span className="text-xs font-semibold">{t("gpuTotalTitle")}</span>
          <span className="ml-auto shrink-0 font-mono text-xs tabular-nums">
            {main ? `${main.value} ${main.unit}` : "—"}
          </span>
        </div>
        {percent !== null && (
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${percent}%` }} />
          </div>
        )}
        {details.length > 0 && <p className="mt-2 font-mono text-xs text-muted-foreground">{details.join(" · ")}</p>}
        {devices.length > 1 && <p className="mt-1 text-xs text-muted-foreground">{t("chartsGpuMultiHint", { count: devices.length })}</p>}
        {failed && <p className="mt-1 text-xs text-destructive">{t("chartsLoadError")}</p>}
      </CardContent>
    </Card>
  );
}
