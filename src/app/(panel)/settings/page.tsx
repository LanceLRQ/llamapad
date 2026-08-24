import { KeyRound, SlidersHorizontal } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { Card, CardContent } from "@/components/ui/card";
import { getDb } from "@/server/db";
import { getHfSettingsSnapshot } from "@/server/hf/settings";
import { getNamespaceService } from "@/server/locators";
import { isAutoSnapshotEnabled } from "@/server/snapshot";
import { HfCard } from "./hf-card";
import { ImportExportCard } from "./import-export-card";
import { NamespacesCard } from "./namespaces-card";

// db + 磁盘扫描 → 全动态渲染
export const dynamic = "force-dynamic";

/**
 * 设置页（M1 Task 12；M2 Task 8 增「导入与备份」；M2 Task 9 增「下载源」区块）：
 * 命名空间（server 直调服务层 listOverview）→ 下载源（HF Token/镜像/代理，
 * server 直调 hf/settings 快照）→ 导入导出/自动快照；管理员密码 / API Token（M2）
 * 与面板运行偏好（M3）以占位卡片占位，结构就位后续往里填。
 */
export default async function SettingsPage() {
  const t = await getTranslations("pages.settings");
  const namespaces = getNamespaceService().listOverview();
  // 自动快照开关初值（开关本身走 PUT /api/v1/settings/auto_snapshot）
  const autoSnapshot = isAutoSnapshotEnabled(getDb());
  // 下载源初值（Token/镜像后续走 PUT /api/v1/settings/hf，快照与 GET 接口同构）
  const hfSnapshot = getHfSettingsSnapshot();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline gap-2.5">
        <h1 className="text-base font-semibold tracking-tight">{t("title")}</h1>
      </div>
      <p className="-mt-2 max-w-2xl text-sm text-muted-foreground">{t("description")}</p>

      <NamespacesCard namespaces={namespaces} />

      <HfCard initial={hfSnapshot} />

      <ImportExportCard autoSnapshotInitial={autoSnapshot} />

      <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
        <Card>
          <CardContent className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <KeyRound className="size-4.5" />
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <h2 className="text-sm font-semibold">{t("accountTitle")}</h2>
              <p className="text-sm text-muted-foreground">{t("accountDescription")}</p>
              <p className="text-xs text-muted-foreground">{t("accountMilestone")}</p>
            </div>
          </CardContent>
        </Card>
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
    </div>
  );
}
