"use client";

import { Archive, Plus } from "lucide-react";
import { useTranslations } from "next-intl";

import { RepoCard, type RepoProfileEntry } from "@/components/models/repo-card";
import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { toGigabytes } from "@/lib/format";
import { RepoCreateNavButton } from "../repo-create-nav-button";

/**
 * 档案列表页内容（任务 9）：卡片网格 + 空态，本身没有需要客户端状态的交互
 * （换存放位置/删除档案是详情页页头的事，本页只负责跳进去）——仍然
 * "use client" 是跟随 downloads/page.tsx 的既定分工：PageHeader 与列表
 * 下沉到本组件内部渲染，与 page.tsx 的纯数据装配彻底分开（任务 9 补充裁定 1）。
 */
export function ReposView({ profiles, folders }: { profiles: RepoProfileEntry[]; folders: string[] }) {
  const t = useTranslations("pages.repos");

  const totalBytes = profiles.reduce((sum, p) => sum + p.bytes, 0);
  const missingCount = profiles.filter((p) => !p.dirExists).length;

  return (
    <>
      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader
          action={<RepoCreateNavButton folders={folders} icon={Plus} repoOnly />}
          icon={Archive}
          title={t("listTitle")}
          subtitle={t("listSubtitle")}
          stats={[
            { value: profiles.length, label: t("statCount"), tone: "hot" },
            { value: toGigabytes(totalBytes), unit: "GB", label: t("statSize") },
            { value: missingCount, label: t("statMissing") },
          ]}
        />

        {/* PageHeader 下方定高之后内容自己滚（page.tsx 已改 h-[calc(100%+76px)]），
            两个分支都要滚，统一包一层而不是各写一遍 overflow-y-auto */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {profiles.length === 0 ? (
            <div className="px-7 py-6">
              <Card>
                <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                  <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                    <Archive className="size-6" />
                  </span>
                  <p className="text-sm font-medium">{t("emptyTitle")}</p>
                  <p className="max-w-md text-sm text-muted-foreground">{t("emptyDescription")}</p>
                </CardContent>
              </Card>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 px-7 py-6 sm:grid-cols-2 xl:grid-cols-3">
              {profiles.map((profile) => (
                <RepoCard key={profile.id} profile={profile} />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
