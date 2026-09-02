import type { ReactNode } from "react";
import { Settings } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { PageHeader } from "@/components/shell/page-header";
import { SecondaryNav } from "@/components/shell/secondary-nav";
import { listApiTokens } from "@/server/auth";
import { getDb } from "@/server/db";
import { getFilesTree } from "@/server/filesApi";
import { getHfSettingsSnapshot } from "@/server/hf/settings";
import { getNamespaceService, getPanelModelsRoot } from "@/server/locators";
import { getHostNetSettingsSnapshot } from "@/server/metrics/hostNetSettings";
import { createModelRepo } from "@/server/repo/models";
import { listPresets } from "@/server/repo/presets";
import { isAutoSnapshotEnabled } from "@/server/snapshot";
import { loadWebhookConfigs } from "@/server/webhookDispatcher";
import { buildPickerItems } from "@/lib/model-file-picker";
import { SETTINGS_TABS, resolveSettingsTab } from "@/lib/settings-tabs";
import { AccountSection } from "./account-section";
import { DoctorCard } from "./doctor-card";
import { HfCard } from "./hf-card";
import { HostNetCard } from "./host-net-card";
import { ImageCard } from "./image-card";
import { ImportExportCard } from "./import-export-card";
import { NamespacesCard } from "./namespaces-card";
import { PresetsCard } from "./presets-card";
import { WebhooksCard } from "./webhooks-card";

// db + 磁盘扫描 → 全动态渲染
export const dynamic = "force-dynamic";

/**
 * 设置页（M1 Task 12；M2 Task 8 增「导入与备份」；M2 Task 9 增「下载源」区块；
 * M5 Task 8 增「账号与安全」——API token 列表/吊销与改密码取代占位卡；
 * UX P1 U18 增「环境自检」卡片，挂第一位——环境问题优先于配置；
 * UX P1 U24 增「Webhook 通知」卡片，挂在运行镜像之后、导入导出之前；
 * M16 T4a 改二级栏四组 + 按组切换，选中组走 URL query `?tab=`——四组各自的
 * 取数实现逐行不变，但只在选中该组时才执行：现在每次只渲染一组卡片，不该
 * 为没显示的三组也白付一遍取数代价（尤其 pickerItems 扫全量 models 目录树、
 * hostNet 是唯一的异步取数）：
 * 环境自检（点击触发 GET /api/v1/doctor，无需初值）→ 命名空间（server 直调
 * 服务层 listOverview）→ 参数预设（server 直调 listPresets；内置三档不落库，
 * 卡片内自行补行）→ 下载源（HF Token/镜像/代理，server 直调 hf/settings
 * 快照）→ 运行镜像 → Webhook 渠道（server 直调 loadWebhookConfigs 取初值，
 * 与 GET /api/v1/settings/webhooks 同源）→ 导入导出/自动快照 → 账号与安全
 * （token 列表 server 侧装配初值，不含明文）。
 * 「面板偏好」占位卡（无交互，功能已在底部状态栏）与顶栏深链复制胶囊已删（真机反馈 13/14）。
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const t = await getTranslations("pages.settings");
  const { tab: rawTab } = await searchParams;
  const tab = resolveSettingsTab(rawTab);

  // 四组卡片归位（规格照抄，组内相对顺序也按规格来，不沿用旧的堆叠顺序）；
  // 每个分支只取该组卡片要用的数据，取数调用本身与改造前一致，只是挪到了
  // 只有命中该组时才会跑到的分支里
  let cards: ReactNode;
  switch (tab) {
    case "runtime": {
      // 运行镜像初值（U14）：当前生效镜像名，拉取端点默认取同一来源
      const currentImage = createModelRepo(getDb()).getDefaultConfig().docker.image;
      cards = (
        <>
          <DoctorCard />
          <ImageCard initialImage={currentImage} />
        </>
      );
      break;
    }
    case "library": {
      const namespaces = getNamespaceService().listOverview();
      // 参数预设初值（T12）：内置三档不落库，DB 里只有用户预设，卡片内自行补内置行
      const presets = listPresets(getDb());
      // 下载源初值（Token/镜像后续走 PUT /api/v1/settings/hf，快照与 GET 接口同构）
      const hfSnapshot = getHfSettingsSnapshot();
      cards = (
        <>
          <NamespacesCard namespaces={namespaces} />
          <PresetsCard presets={presets} />
          <HfCard initial={hfSnapshot} />
        </>
      );
      break;
    }
    case "monitor": {
      // 宿主机网络监控网卡初值（追加需求）：与 GET /api/v1/settings/host-net 同源
      const hostNet = await getHostNetSettingsSnapshot(getDb());
      // Webhook 渠道初值（U24）：与 GET /api/v1/settings/webhooks 同源（loadWebhookConfigs）
      const webhooks = loadWebhookConfigs(getDb());
      cards = (
        <>
          <HostNetCard initial={hostNet} />
          <WebhooksCard initial={webhooks} />
        </>
      );
      break;
    }
    case "account": {
      // API token 列表初值（签发/吊销由 AccountSection 内 fetch + router.refresh() 刷新）
      const apiTokens = listApiTokens(getDb());
      // 自动快照开关初值（开关本身走 PUT /api/v1/settings/auto_snapshot）
      const autoSnapshot = isAutoSnapshotEnabled(getDb());
      // 导入重指的文件选择弹层候选项（T4，规格 §4）：与模型编辑页同款做法，
      // server 侧直接扫盘装配，不为导入卡单独起一个 HTTP 往返；只有 account
      // 组要用，扫的又是上百 GB 量级的 models 目录树，不该在看别的组时也扫
      const pickerItems = buildPickerItems(
        getFilesTree(getDb(), getPanelModelsRoot()).flatMap((ns) => ns.files),
      );
      cards = (
        <>
          <AccountSection initialTokens={apiTokens} />
          <ImportExportCard autoSnapshotInitial={autoSnapshot} pickerItems={pickerItems} />
        </>
      );
      break;
    }
  }

  const navItems = SETTINGS_TABS.map(({ key, number }) => ({
    key,
    name: t(`groups.${key}.name`),
    meta: t(`groups.${key}.meta`),
    lead: { kind: "number" as const, text: number },
  }));

  return (
    // 二级栏必须贴到应用外壳的框边：T1 给 main 留了 px-[34px] pt-7 pb-12，
    // 本页在这一层用负边距抵消掉。这是 T1→T11 迁移期的过渡做法，T4b 之后
    // 各页统一处理，届时这段注释与负边距一起删。
    //
    // h- 而非 min-h-：min-h-full 只等于 main 的内容盒（不含上面抵消掉的
    // pt-7 28 + pb-12 48 = 76px），二级栏那条右边框会停在离底 76px 的地方；
    // 定高之后内容不再撑长 main，右侧内容列改由自己滚动（见下方 overflow-y-auto）
    <div className="-mx-[34px] -mt-7 -mb-12 flex h-[calc(100%+76px)]">
      <SecondaryNav
        kicker="SETTINGS"
        title={t("title")}
        items={navItems}
        queryKey="tab"
        current={tab}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader
          icon={Settings}
          title={t(`groups.${tab}.name`)}
          subtitle={t(`groups.${tab}.subtitle`)}
        />
        {/* 卡片不能直接当这层滚动容器的 flex 子项——flex-shrink 默认为 1，
            内容总高超出容器时每张卡都会被压缩，而 Card 带 overflow-hidden，
            压缩掉的部分是直接裁掉而不是溢出可见。中间再套一层普通的
            flex-col（不接收 flex-1/min-h-0），把卡片挪出高度约束，
            高度完全由内容撑开，滚动交给外层处理 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
          <div className="flex flex-col gap-4">{cards}</div>
        </div>
      </div>
    </div>
  );
}
