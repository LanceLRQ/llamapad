import Link from "next/link";
import { headers } from "next/headers";
import { Waypoints } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { PageHeader } from "@/components/shell/page-header";
import { initiallyExpanded } from "@/lib/relay-layout";
import { originFromHeaders } from "@/lib/relay-snippet";
import { getDb } from "@/server/db";
import { getRuntimeService, getUpstreamMonitor } from "@/server/locators";
import { buildRelayOverview } from "@/server/relayOverview";
import { getDefaultUpstream, listUpstreams } from "@/server/repo/upstreams";
import { toUpstreamView } from "@/server/upstreams/view";
import { AccessCard } from "./access-card";
import { ManagedServiceRow } from "./managed-service-row";
import { RelayWorkspace } from "./relay-workspace";

// 读请求头 + 运行状态 → 全动态渲染
export const dynamic = "force-dynamic";

/**
 * API 中转页：接入信息 + 运行中托管模型的系统级卡片。
 * 数据与 GET /api/v1/relay/overview 同源，服务端直接调装配函数，不经 HTTP。
 * 外部上游列表的初值在这里装配（与 GET /api/v1/upstreams 同源），之后由
 * <RelayWorkspace> 持有、<UpstreamsSection> 轮询刷新。
 */
export default async function RelayPage() {
  const t = await getTranslations("pages.relay");
  const requestHeaders = await headers();
  const origin = originFromHeaders((name) => requestHeaders.get(name));
  const db = getDb();
  const monitor = getUpstreamMonitor();
  const overview = await buildRelayOverview(db, getRuntimeService(), monitor);
  const storedDefault = getDefaultUpstream(db);
  const upstreams = listUpstreams(db).map((stored) => toUpstreamView(stored, monitor.snapshot(stored.name), storedDefault));

  const expanded = initiallyExpanded(overview.services);

  return (
    // 负边距抵消应用外壳给 main 留的内边距，让页头的分隔线贴到框边（与概览页同款）。
    // xl 起整页定高、只有主栏自己滚动，高度写法与概览页同源同理由：76px 是把
    // -mt-7 / -mb-12 抵消掉的 28 + 48 原样加回来，三个数字在同一个元素上，要改一起改。
    // xl 以下退化为单栏，整页随内容滚动
    <div className="-mx-[34px] -mt-7 -mb-12 flex min-h-full flex-col xl:h-[calc(100%+76px)] xl:min-h-96">
      <PageHeader icon={Waypoints} title={t("title")} subtitle={t("description")} />
      <RelayWorkspace
        initialUpstreams={upstreams}
        services={overview.services.map((s) => ({ model: s.model, displayName: s.displayName, ready: s.ready }))}
        managedDefault={overview.managedDefault}
        access={
          <AccessCard
            origin={origin}
            defaultTarget={overview.defaultTarget}
            defaultUpstream={overview.defaultUpstream}
          />
        }
        managed={
          <section className="flex flex-col gap-3">
            <div>
              <h2 className="text-sm font-semibold">{t("managed.title")}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">{t("managed.description")}</p>
            </div>
            {overview.services.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
                <span>{t("managed.empty")}</span>
                <Link href="/models" className="text-primary hover:underline">
                  {t("managed.emptyLink")}
                </Link>
              </div>
            ) : (
              <div className="divide-y overflow-hidden rounded-xl border bg-card">
                {overview.services.map((service) => (
                  <ManagedServiceRow key={service.model} service={service} defaultOpen={expanded.has(service.model)} />
                ))}
              </div>
            )}
          </section>
        }
      />
    </div>
  );
}
