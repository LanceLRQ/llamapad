import { SlidersHorizontal } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { Card, CardContent } from "@/components/ui/card";
import { listApiTokens } from "@/server/auth";
import { getDb } from "@/server/db";
import { getHfSettingsSnapshot } from "@/server/hf/settings";
import { getNamespaceService } from "@/server/locators";
import { getHostNetSettingsSnapshot } from "@/server/metrics/hostNetSettings";
import { createModelRepo } from "@/server/repo/models";
import { isAutoSnapshotEnabled } from "@/server/snapshot";
import { loadWebhookConfigs } from "@/server/webhookDispatcher";
import { AccountSection } from "./account-section";
import { DoctorCard } from "./doctor-card";
import { HfCard } from "./hf-card";
import { HostNetCard } from "./host-net-card";
import { ImageCard } from "./image-card";
import { ImportExportCard } from "./import-export-card";
import { NamespacesCard } from "./namespaces-card";
import { WebhooksCard } from "./webhooks-card";

// db + 磁盘扫描 → 全动态渲染
export const dynamic = "force-dynamic";

/**
 * 设置页（M1 Task 12；M2 Task 8 增「导入与备份」；M2 Task 9 增「下载源」区块；
 * M5 Task 8 增「账号与安全」——API token 列表/吊销与改密码取代占位卡；
 * UX P1 U18 增「环境自检」卡片，挂第一位——环境问题优先于配置；
 * UX P1 U24 增「Webhook 通知」卡片，挂在运行镜像之后、导入导出之前）：
 * 环境自检（点击触发 GET /api/v1/doctor，无需初值）→ 命名空间（server 直调
 * 服务层 listOverview）→ 下载源（HF Token/镜像/代理，server 直调 hf/settings
 * 快照）→ 运行镜像 → Webhook 渠道（server 直调 loadWebhookConfigs 取初值，
 * 与 GET /api/v1/settings/webhooks 同源）→ 导入导出/自动快照 → 账号与安全
 * （token 列表 server 侧装配初值，不含明文）→ 面板偏好（说明性占位，功能在顶栏）。
 */
export default async function SettingsPage() {
  const t = await getTranslations("pages.settings");
  const namespaces = getNamespaceService().listOverview();
  // 自动快照开关初值（开关本身走 PUT /api/v1/settings/auto_snapshot）
  const autoSnapshot = isAutoSnapshotEnabled(getDb());
  // 下载源初值（Token/镜像后续走 PUT /api/v1/settings/hf，快照与 GET 接口同构）
  const hfSnapshot = getHfSettingsSnapshot();
  // API token 列表初值（签发/吊销由 AccountSection 内 fetch + router.refresh() 刷新）
  const apiTokens = listApiTokens(getDb());
  // 运行镜像初值（U14）：当前生效镜像名，拉取端点默认取同一来源
  const currentImage = createModelRepo(getDb()).getDefaultConfig().docker.image;
  // Webhook 渠道初值（U24）：与 GET /api/v1/settings/webhooks 同源（loadWebhookConfigs）
  const webhooks = loadWebhookConfigs(getDb());
  // 宿主机网络监控网卡初值（追加需求）：与 GET /api/v1/settings/host-net 同源
  const hostNet = await getHostNetSettingsSnapshot(getDb());

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline gap-2.5">
        <h1 className="text-base font-semibold tracking-tight">{t("title")}</h1>
      </div>
      <p className="-mt-2 max-w-2xl text-sm text-muted-foreground">{t("description")}</p>

      <DoctorCard />

      <HostNetCard initial={hostNet} />

      <NamespacesCard namespaces={namespaces} />

      <HfCard initial={hfSnapshot} />

      <ImageCard initialImage={currentImage} />

      <WebhooksCard initial={webhooks} />

      <ImportExportCard autoSnapshotInitial={autoSnapshot} />

      <AccountSection initialTokens={apiTokens} />

      <Card>
        <CardContent className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <SlidersHorizontal className="size-4.5" />
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="text-sm font-semibold">{t("prefsTitle")}</h2>
            <p className="text-sm text-muted-foreground">{t("prefsDescription")}</p>
            <p className="text-xs text-muted-foreground">{t("prefsMilestone")}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
