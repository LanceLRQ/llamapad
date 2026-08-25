import Link from "next/link";
import { ArrowRight, HardDrive, ScrollText } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatSize } from "@/lib/format";
import { getDb } from "@/server/db";
import { getDiskUsage } from "@/server/fsScanner";
import { getMetricsCollector, getPanelModelsRoot, getRuntimeService } from "@/server/locators";
import { decorateRuntimeStatus, type RuntimeStatusView } from "@/server/modelsView";
import { createModelRepo } from "@/server/repo/models";
import { OverviewCharts } from "./overview-charts";
import { RuntimeCardActions } from "./runtime-card-actions";

// db + 运行状态 + 文件扫描（fs）→ 全动态渲染
export const dynamic = "force-dynamic";

/** 事件流卡展示条数（与 GET /api/v1/events 的默认 limit 一致） */
const EVENTS_LIMIT = 20;

/** events 表行（与 migrations.ts v1 的 events 表对应） */
interface EventRow {
  id: number;
  ts: number;
  kind: string;
  message: string;
}

/** 事件 kind → 圆点色：start 绿 / stop 灰 / update amber / delete 与 start_failed 红 */
const EVENT_DOT_CLASS: Record<string, string> = {
  "model.start": "bg-accent-green",
  "model.stop": "bg-muted-foreground/40",
  "model.update": "bg-amber-500",
  "model.delete": "bg-accent-red",
  "model.start_failed": "bg-accent-red",
};

/**
 * 概览页（M1 Task 9，M3 Task 4 补图表）：左列监控图表（client 组件，
 * fetch window API + 自动刷新），右列静态三卡（运行状态 / 磁盘 / 事件流）。
 * server 侧一次装配右列数据（不经 HTTP），与 /api/v1/{runtime/status,events,disk}
 * 共享同一批装配函数。
 *
 * 相对时间取舍：启动时间用服务端绝对时间（Intl.DateTimeFormat 按 cookie
 * locale 格式化）——RSC 输出无 hydration 语义问题，也不必为"3 分钟前"
 * 引入客户端计时。
 */
export default async function OverviewPage() {
  const t = await getTranslations("pages.overview");
  const locale = await getLocale();
  const startedFmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const eventFmt = new Intl.DateTimeFormat(locale, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  getMetricsCollector(); // 打开概览即确保指标采集心跳在跑（幂等单例）

  const db = getDb();
  const status: RuntimeStatusView = await decorateRuntimeStatus(db, getRuntimeService());
  const disk = await getDiskUsage(getPanelModelsRoot());
  const events = db
    .prepare("SELECT id, ts, kind, message FROM events ORDER BY ts DESC, id DESC LIMIT ?")
    .all(EVENTS_LIMIT) as EventRow[];
  const hasModels = createModelRepo(db).listModels().length > 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline gap-2.5">
        <h1 className="text-base font-semibold tracking-tight">{t("title")}</h1>
      </div>

      <div className="grid items-stretch gap-4.5 lg:grid-cols-[1fr_380px]">
        {/* 左列：监控图表（GPU / 容器 / 推理，client 组件自取数与刷新） */}
        <div className="flex min-w-0 flex-col gap-4.5">
          <OverviewCharts />
        </div>

        {/* 右列：运行状态 / 磁盘 / 事件流 */}
        <div className="flex min-w-0 flex-col gap-4.5">
          {/* ---- 运行状态卡 ---- */}
          <Card>
            <CardContent>
              {status.running ? (
                <>
                  <Badge
                    variant="outline"
                    className="gap-1.5 border-accent-green/25 bg-accent-green/10 text-accent-green"
                  >
                    <span className="size-1.5 rounded-full bg-accent-green" />
                    {t("statusRunning")}
                  </Badge>
                  <div className="mt-2.5 font-mono text-lg leading-tight font-bold">
                    {status.running.displayName}
                  </div>
                  <div className="text-[13px] text-muted-foreground">{status.running.model}</div>

                  <dl className="mt-3 flex flex-col gap-1.5 text-xs">
                    <div className="flex items-center justify-between gap-3">
                      <dt className="shrink-0 text-muted-foreground">{t("fieldContainer")}</dt>
                      <dd className="truncate font-mono" title={status.running.container}>
                        {status.running.container}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="shrink-0 text-muted-foreground">{t("fieldPort")}</dt>
                      <dd className="font-mono tabular-nums">
                        {status.running.hostPort !== null ? `:${status.running.hostPort}` : "—"}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="shrink-0 text-muted-foreground">{t("fieldStartedAt")}</dt>
                      <dd className="tabular-nums">
                        {status.running.startedAt
                          ? startedFmt.format(new Date(status.running.startedAt))
                          : "—"}
                      </dd>
                    </div>
                  </dl>

                  <div className="mt-3.5">
                    <RuntimeCardActions modelName={status.running.model} />
                  </div>
                </>
              ) : (
                <>
                  <Badge
                    variant="outline"
                    className="gap-1.5 text-xs text-muted-foreground"
                  >
                    <span className="size-1.5 rounded-full bg-muted-foreground/40" />
                    {t("statusIdle")}
                  </Badge>
                  <div className="mt-2.5 text-sm font-medium">
                    {hasModels ? t("idleTitle") : t("idleEmptyTitle")}
                  </div>
                  <p className="mt-1 text-[13px] text-muted-foreground">
                    {hasModels ? t("idleHint") : t("idleEmptyHint")}
                  </p>
                  {/* M1 简化：不在概览直接启动（"上次运行的模型"无状态可查），跳模型列表选择 */}
                  <Button
                    size="sm"
                    className="mt-3.5 w-full"
                    render={<Link href="/models" />}
                  >
                    {t("gotoModels")}
                    <ArrowRight className="size-3.5" />
                  </Button>
                </>
              )}
            </CardContent>
          </Card>

          {/* ---- 磁盘卡 ---- */}
          <Card>
            <CardContent>
              <div className="flex items-center gap-2">
                <HardDrive className="size-3.5 text-muted-foreground" />
                <span className="text-xs font-semibold">{t("diskTitle")}</span>
                <div className="flex-1" />
                <span className="font-mono text-xs tabular-nums">
                  {disk.totalBytes !== null
                    ? `${formatSize(disk.usedBytes)} / ${formatSize(disk.totalBytes)}`
                    : t("diskUsedOnly", { used: formatSize(disk.usedBytes) })}
                </span>
              </div>

              {/* total 未知（statfs 失败）时降级：只展示 used，不画占比条 */}
              {disk.totalBytes !== null && (
                <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{
                      width: `${Math.min(100, (disk.usedBytes / disk.totalBytes) * 100).toFixed(2)}%`,
                    }}
                  />
                </div>
              )}

              <div className="mt-3 flex flex-col gap-2">
                {disk.perNamespace.map((ns) => (
                  <div key={ns.namespace} className="flex items-center gap-2.5">
                    <span className="w-16 shrink-0 truncate font-mono text-xs">{ns.namespace}</span>
                    <div className="h-1 min-w-8 flex-1 overflow-hidden rounded-full bg-muted">
                      {/* 迷你条为该命名空间占已用的比例（各条之和 ≈ 100%） */}
                      <div
                        className="h-full rounded-full bg-muted-foreground/40"
                        style={{
                          width: `${disk.usedBytes > 0 ? ((ns.bytes / disk.usedBytes) * 100).toFixed(2) : 0}%`,
                        }}
                      />
                    </div>
                    <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                      {formatSize(ns.bytes)}
                    </span>
                  </div>
                ))}
                {disk.perNamespace.length === 0 && (
                  <p className="text-xs text-muted-foreground">{t("diskEmpty")}</p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* ---- 事件流卡 ---- */}
          <Card>
            <CardContent className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <ScrollText className="size-3.5 text-muted-foreground" />
                <span className="text-xs font-semibold">{t("eventsTitle")}</span>
              </div>

              {events.length > 0 ? (
                <ul className="flex flex-col">
                  {events.map((event) => (
                    <li
                      key={event.id}
                      className="flex items-start gap-2.5 border-b py-2 text-xs last:border-b-0"
                    >
                      <span
                        className={`mt-1 size-1.5 shrink-0 rounded-full ${EVENT_DOT_CLASS[event.kind] ?? "bg-muted-foreground/40"}`}
                      />
                      <span className="w-[72px] shrink-0 font-mono tabular-nums text-muted-foreground">
                        {eventFmt.format(new Date(event.ts))}
                      </span>
                      <span className="min-w-0 flex-1 break-words">{event.message}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-4 text-center text-xs text-muted-foreground">{t("eventsEmpty")}</p>
              )}

              <p className="text-[11px] text-muted-foreground">{t("eventsRecentOnly")}</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
