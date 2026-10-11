import Link from "next/link";
import { headers } from "next/headers";
import { Waypoints } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { PageHeader } from "@/components/shell/page-header";
import { originFromHeaders } from "@/lib/relay-snippet";
import { getDb } from "@/server/db";
import { getRuntimeService, getUpstreamMonitor } from "@/server/locators";
import { buildRelayOverview } from "@/server/relayOverview";
import { getDefaultUpstream, listUpstreams } from "@/server/repo/upstreams";
import { toUpstreamView } from "@/server/upstreams/view";
import { AccessCard } from "./access-card";
import { ManagedServiceCard } from "./managed-service-card";
import { UpstreamsSection } from "./upstreams-section";

// 读请求头 + 运行状态 → 全动态渲染
export const dynamic = "force-dynamic";

/**
 * API 中转页：接入信息 + 运行中托管模型的系统级卡片。
 * 数据与 GET /api/v1/relay/overview 同源，服务端直接调装配函数，不经 HTTP。
 * 外部上游列表的初值在这里装配（与 GET /api/v1/upstreams 同源），之后由
 * <UpstreamsSection> 自己轮询刷新。
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

  return (
    // 负边距抵消应用外壳给 main 留的内边距，让页头的分隔线贴到框边（与概览页同款）
    <div className="-mx-[34px] -mt-7 -mb-12 flex min-h-full flex-col">
      <PageHeader icon={Waypoints} title={t("title")} subtitle={t("description")} />
      <div className="flex flex-col gap-4.5 px-7 py-6">
        <AccessCard origin={origin} defaultTarget={overview.defaultTarget} defaultUpstream={overview.defaultUpstream} />

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
            <div className="grid gap-4 lg:grid-cols-2">
              {overview.services.map((service) => (
                <ManagedServiceCard key={service.model} service={service} />
              ))}
            </div>
          )}
        </section>

        <UpstreamsSection initial={upstreams} />
      </div>
    </div>
  );
}
