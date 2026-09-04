"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";

import { NewDownloadDialog } from "@/components/downloads/new-download-dialog";
import { Button } from "@/components/ui/button";

/**
 * 「新建下载」二级栏入口（批 6 任务 12；UI 打磨批追加 icon/repoOnly 两个
 * prop 后，与档案页头「＋」入口共用同一个组件）：此前 /models/repos 本身
 * 没有新建入口，点过去只能看列表——批 6 把弹层接通之后，这里直接唤起弹层，
 * 与 namespace-create-nav-button.tsx 同款结构（图标按钮 + 自己攥 open
 * state），folders 由各自 page.tsx 的 scanTree 结果透传，不再另外查一遍。
 *
 * icon 默认 Download（/models 页头用它，语义是「新建下载」）；档案页头的
 * 「＋」入口传 Plus + repoOnly，后者让弹层只保留仓库档案页签、隐藏 URL
 * 直链方式（见 new-download-dialog.tsx 的 repoOnly prop）。
 */
export function RepoCreateNavButton({
  folders,
  icon: Icon = Download,
  repoOnly = false,
}: {
  folders: string[];
  icon?: LucideIcon;
  repoOnly?: boolean;
}) {
  const t = useTranslations("pages.models");
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        title={t("repoCreateTitle")}
        aria-label={t("repoCreateTitle")}
        onClick={() => setOpen(true)}
      >
        <Icon className="size-3.5" />
      </Button>
      <NewDownloadDialog open={open} onOpenChange={setOpen} folders={folders} repoOnly={repoOnly} />
    </>
  );
}
