import Link from "next/link";
import { ArrowRight, HardDrive, LayoutDashboard } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CopyCurlButton } from "@/components/copy-curl-button";
import { PageHeader } from "@/components/shell/page-header";
import { formatSize } from "@/lib/format";
import { isOnboardingComplete, onboardingSteps } from "@/lib/onboarding";
import { getDb } from "@/server/db";
import { getDiskUsage } from "@/server/fsScanner";
import { getMetricsCollector, getPanelModelsRoot, getRuntimeService } from "@/server/locators";
import { decorateRuntimeStatus, type RuntimeStatusView } from "@/server/modelsView";
import { createModelRepo } from "@/server/repo/models";
import { OnboardingCard } from "./onboarding-card";
import { OverviewCharts } from "./overview-charts";
import { OverviewEventsCard, type EventRow } from "./overview-events-card";
import { RuntimeCardActions } from "./runtime-card-actions";

// db + 运行状态 + 文件扫描（fs）→ 全动态渲染
export const dynamic = "force-dynamic";

/** 事件流卡展示条数（与 GET /api/v1/events 的默认 limit 一致；SSR 初始数据） */
const EVENTS_LIMIT = 20;

/**
 * 概览页（M1 Task 9，M3 Task 4 补图表，Task 7 事件卡实时化）：左列监控图表
 * （client 组件，fetch window API + 自动刷新），右列三卡（运行状态 / 磁盘 /
 * 事件流）。server 侧一次装配右列数据（不经 HTTP），事件卡接收 SSR 初始数据
 * 后用 SSE 增量实时化（见 overview-events-card.tsx）。
 *
 * 相对时间取舍：启动时间用服务端绝对时间（Intl.DateTimeFormat 按 cookie
 * locale 格式化）——RSC 输出无 hydration 语义问题，也不必为"3 分钟前"
 * 引入客户端计时。
 */
export default async function OverviewPage() {
  const t = await getTranslations("pages.overview");
  const locale = await getLocale();
  const startedFmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });

  getMetricsCollector(); // 打开概览即确保指标采集心跳在跑（幂等单例）

  const db = getDb();
  const status: RuntimeStatusView = await decorateRuntimeStatus(db, getRuntimeService());
  const disk = await getDiskUsage(getPanelModelsRoot());
  const events = db
    .prepare("SELECT id, ts, kind, message FROM events ORDER BY ts DESC, id DESC LIMIT ?")
    .all(EVENTS_LIMIT) as EventRow[];
  const repo = createModelRepo(db);
  const models = repo.listModels();
  const hasModels = models.length > 0;

  // 首启动引导（UX P1 U22）：四步判据全部由既有表推导，不新增埋点表
  const everStarted =
    db.prepare("SELECT 1 FROM events WHERE kind = 'model.start' LIMIT 1").get() !== undefined;
  const playgroundSeenRow = db
    .prepare("SELECT value FROM settings WHERE key = 'onboarding_playground_seen'")
    .get() as { value: string } | undefined;
  const onboarding = onboardingSteps({
    namespaceCount: repo.listNamespaces().length,
    modelCount: models.length,
    everStarted,
    playgroundSeen: playgroundSeenRow?.value === "1",
  });

  return (
    // PageHeader 自带 border-b + px-7：内边距的控制权要交给页面自己，才能让这条
    // border-b 与其它套了同款外壳的页面一样通栏（与有没有二级栏无关）。T1 给 main
    // 留了 px-[34px] pt-7 pb-12，这里用负边距抵消，内容区再用 px-7 py-6 接回来。
    // 这是 T1→T11 迁移期的过渡做法，之后各页统一处理，届时这段注释与负边距一起删。
    //
    // lg 起左右两栏各自独立滚动（见下方栅格与两列 div 的 lg:overflow-y-auto）：
    // 这需要本页自己撑满 main 的高度而不是随内容一路往下长，故加
    // lg:h-[calc(100%+76px)]——76px 是把上面抵消掉的 pt-7 28 + pb-12 48 原样
    // 加回来（与 monitoring/page.tsx、chat/page.tsx 同源同理由，三个数字在
    // 同一个元素上，要改一起改）。lg 以下栅格塌成单列，两个独立滚动区竖着
    // 叠在一起是反直觉的，因此这套写法只在 lg 起生效，窄屏保留整页滚动。
    <div className="-mx-[34px] -mt-7 -mb-12 flex min-h-full flex-col lg:h-[calc(100%+76px)] lg:min-h-96">
      <PageHeader icon={LayoutDashboard} title={t("title")} subtitle={t("description")} />

      <div className="flex min-h-0 flex-1 flex-col gap-4 px-7 py-6">
        <div className="grid items-stretch gap-4.5 lg:min-h-0 lg:flex-1 lg:grid-cols-[1fr_380px] lg:grid-rows-[minmax(0,1fr)]">
          {/* 左列：监控图表（GPU / 容器 / 推理，client 组件自取数与刷新）。
              本身不滚动——内部工具条固定、图卡栅格滚动，见 overview-charts.tsx */}
          <div className="flex min-w-0 flex-col gap-4.5 lg:min-h-0">
            <OverviewCharts initialGpuStatus={getMetricsCollector().nvidiaStatus()} />
          </div>

          {/* 右列：（首启动）引导 / 运行状态 / 磁盘 / 事件流；lg:pr-1 给滚动条
              留道，否则滚动条会压在卡片描边上。
              lg:[&>*]:shrink-0 不能省：flex 子项默认 min-height:auto 本可以挡住
              「压到内容以下」，但 Card 自带 overflow-hidden，这会把自动最小尺寸
              算成 0，于是本列一有定高，四张卡就会被压扁并裁掉内容（实测 vh=900
              时引导卡渲染 114px / 内容 247px），而不是撑出滚动条。左列不需要这行
              ——它的子项是 overflow 可见的栅格容器，自动最小尺寸仍然生效 */}
          <div className="flex min-w-0 flex-col gap-4.5 lg:min-h-0 lg:overflow-y-auto lg:pr-1 lg:[&>*]:shrink-0">
            {/* ---- 首启动引导卡（全部完成后不渲染，老用户永不见此卡） ---- */}
            {!isOnboardingComplete(onboarding) && <OnboardingCard steps={onboarding} />}

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
                        <dd className="flex items-center gap-0.5 font-mono tabular-nums">
                          {status.running.hostPort !== null ? `:${status.running.hostPort}` : "—"}
                          {status.running.hostPort !== null && (
                            <CopyCurlButton hostPort={status.running.hostPort} size="icon" />
                          )}
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
                      <RuntimeCardActions
                        modelName={status.running.model}
                        displayName={status.running.displayName}
                      />
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
                      nativeButton={false} render={<Link href="/models" />}
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

            {/* ---- 事件流卡（client：SSE 实时增量，SSR 数据兜底首帧） ---- */}
            <OverviewEventsCard initialEvents={events} />
          </div>
        </div>
      </div>
    </div>
  );
}
