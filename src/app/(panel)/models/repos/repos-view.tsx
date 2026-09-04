"use client";

import Link from "next/link";
import { Archive, FolderX, Plus } from "lucide-react";
import { useTranslations } from "next-intl";

import { PageHeader } from "@/components/shell/page-header";
import { SecondaryNav } from "@/components/shell/secondary-nav";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatSize, toGigabytes } from "@/lib/format";
import { buildModelsTabItems } from "@/lib/models-tabs";
import { RepoCreateNavButton } from "../repo-create-nav-button";

/** 与 GET /api/v1/repos 响应中单项字段一致（page.tsx 直接装配同款派生字段） */
export interface RepoProfileEntry {
  id: number;
  repo: string;
  baseDir: string;
  targetDir: string;
  createdAt: number;
  fileCount: number;
  bytes: number;
  /** bytes 里与全树别处共用同一 inode 的部分（硬链接）。本页暂不展示，声明
   *  出来是因为服务端（decorateProfileStats / GET /api/v1/repos）确实会给这个
   *  字段——不声明只是靠「变量传参躲过 TS 多余属性检查」，两侧类型一脱节就
   *  只能在运行时发现 */
  sharedBytes?: number;
  dirExists: boolean;
}

/**
 * 档案列表页内容（任务 9）：卡片网格 + 空态，本身没有需要客户端状态的交互
 * （换存放位置/删除档案是详情页页头的事，本页只负责跳进去）——仍然
 * "use client" 是跟随 downloads/page.tsx 的既定分工：SecondaryNav/PageHeader
 * 下沉到本组件内部渲染，与 page.tsx 的纯数据装配彻底分开（任务 9 补充裁定 1）。
 */
export function ReposView({ profiles, folders }: { profiles: RepoProfileEntry[]; folders: string[] }) {
  const t = useTranslations("pages.repos");
  const tModels = useTranslations("pages.models");
  // 二级栏顶部两条 tab（任务 9 裁定 7）：与 /models、/models/repos/[id] 共用
  // 同一份构造，选中项由 pathname 判定而不是硬写，见 lib/models-tabs.ts
  const tabItems = buildModelsTabItems("/models/repos", tModels);

  const totalBytes = profiles.reduce((sum, p) => sum + p.bytes, 0);
  const missingCount = profiles.filter((p) => !p.dirExists).length;

  return (
    <>
      <SecondaryNav
        kicker="MODELS"
        title={tModels("title")}
        items={tabItems}
        // 本页没有第二层可选集合（不像 /models 下面还挂着命名空间列表），
        // queryKey/current 只是满足 props 契约——items 全是 href 型，选中态
        // 由各自的 selected 覆盖决定，这两个值不会被用到
        queryKey="tab"
        current="repos"
        // 档案页「＋新建」入口（UI 打磨批）：复用 /models 页头同款按钮，传
        // repoOnly 隐藏 URL 直链页签——本页语义是「仓库档案」，不该再露出
        // 一个建出来就不是仓库档案的分支
        titleAction={<RepoCreateNavButton folders={folders} icon={Plus} repoOnly />}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader
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

function RepoCard({ profile }: { profile: RepoProfileEntry }) {
  const t = useTranslations("pages.repos");
  return (
    <Link href={`/models/repos/${profile.id}`} className="block h-full">
      <Card className="h-full transition-colors hover:bg-muted/40">
        <CardContent className="flex h-full flex-col gap-2">
          <div className="flex items-start justify-between gap-2">
            <span className="min-w-0 truncate font-mono text-sm font-semibold">{profile.repo}</span>
            {!profile.dirExists && (
              <Badge
                variant="outline"
                className="shrink-0 gap-1 border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
              >
                <FolderX className="size-3!" />
                {t("cardDirMissing")}
              </Badge>
            )}
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {t("cardTargetDir", { dir: profile.targetDir })}
          </p>
          <p className="mt-auto text-xs text-muted-foreground">
            {t("cardFileCount", { count: profile.fileCount })} · {formatSize(profile.bytes)}
          </p>
        </CardContent>
      </Card>
    </Link>
  );
}
