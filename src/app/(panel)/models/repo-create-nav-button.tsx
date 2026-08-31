"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { useTranslations } from "next-intl";

import { NewDownloadDialog } from "@/components/downloads/new-download-dialog";
import { Button } from "@/components/ui/button";

/**
 * 模型页二级栏「新建下载」入口（批 6 任务 12）：此前这里是一个跳
 * `/models/repos` 的裸链接，档案页本身没有新建入口，点过去只能看列表——
 * 批 6 把弹层接通之后，这里直接唤起弹层，与 namespace-create-nav-button.tsx
 * 同款结构（图标按钮 + 自己攥 open state），folders 由 page.tsx 的 scanTree
 * 结果透传，不再另外查一遍。
 */
export function RepoCreateNavButton({ folders }: { folders: string[] }) {
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
        <Download className="size-3.5" />
      </Button>
      <NewDownloadDialog open={open} onOpenChange={setOpen} folders={folders} />
    </>
  );
}
