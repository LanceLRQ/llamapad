import { Box } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { PageHeader } from "@/components/shell/page-header";
import { pickRecentRepos } from "@/lib/recent-repos";
import { getDb } from "@/server/db";
import { scanTree } from "@/server/fsScanner";
import { getPanelModelsRoot, getRuntimeService } from "@/server/locators";
import { decorateRuntimeStatus, managedDefaultForDisplay } from "@/server/modelsView";
import { createModelRepo } from "@/server/repo/models";
import { decorateProfileStats, listProfiles } from "@/server/repoProfiles";
import { HomeDiscover } from "./home-discover";
import { HomeRepos } from "./home-repos";
import { HomeRunning } from "./home-running";
import { RepoCreateNavButton } from "./repo-create-nav-button";

// db + 运行状态 + 文件扫描（fs）→ 全动态渲染
export const dynamic = "force-dynamic";

/**
 * 模型区首页（2026-09-21 设计 §3）：进入模型区最先想知道的两件事——哪些模型
 * 在跑、手上有哪些仓库。配置列表已迁往 /models/profiles，本页不按命名空间切片。
 */
export default async function ModelsHomePage() {
  const tHome = await getTranslations("pages.modelsHome");

  const tree = scanTree(getPanelModelsRoot());
  const profiles = decorateProfileStats(listProfiles(getDb()), tree);
  const recentRepos = pickRecentRepos(profiles);
  const status = await decorateRuntimeStatus(getDb(), getRuntimeService());
  const configCount = createModelRepo(getDb()).listModels().length;

  return (
    // 页头固定，正文使用各页面自身的内部滚动区。
    <div className="-mx-[34px] -mt-7 -mb-12 flex h-[calc(100%+76px)]">
      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader
          action={<RepoCreateNavButton folders={tree.map((g) => g.folder)} />}
          icon={Box}
          title={tHome("title")}
          subtitle={tHome("subtitle")}
          stats={[
            { value: status.models.length, label: tHome("statRunning"), tone: "hot" },
            { value: configCount, label: tHome("statConfigs") },
            { value: profiles.length, label: tHome("statRepos") },
          ]}
        />
        <div className="min-h-0 flex-1 overflow-y-auto pt-6">
          <HomeRunning models={status.models} defaultModel={managedDefaultForDisplay(getDb(), status)} />
          <HomeRepos repos={recentRepos} total={profiles.length} />
          <HomeDiscover
            ownedRepos={Object.fromEntries(profiles.map((p) => [p.repo, p.id]))}
            folders={tree.map((g) => g.folder)}
          />
        </div>
      </div>
    </div>
  );
}
