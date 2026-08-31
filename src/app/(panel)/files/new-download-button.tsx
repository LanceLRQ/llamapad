"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";

import { NewDownloadDialog } from "@/components/downloads/new-download-dialog";
import { Button } from "@/components/ui/button";

/**
 * 文件页面包屑工具条「新建下载」按钮（批 6 任务 12 修复）：此前这里是
 * `<Link href="/models/new?dir=...">`，向导「存放位置」步骤在任务 10 已被
 * 删掉，`?dir=` 参数早已静默失效——按钮文案还写着「新建下载」，点进去的
 * 向导却完全不下载任何东西。改成唤起统一弹层并把当前浏览的目录透传为
 * `defaultBaseDir`，与 create-folder-dialog.tsx（文件页专属包装）同款结构：
 * 共享组件本体不关心"从哪个页面唤起"，差异全部收在这层薄包装里。
 */
export function NewDownloadButton({
  folders,
  defaultBaseDir,
}: {
  folders: string[];
  defaultBaseDir: string;
}) {
  const t = useTranslations("pages.files");
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" />
        {t("newDownloadButton")}
      </Button>
      <NewDownloadDialog open={open} onOpenChange={setOpen} folders={folders} defaultBaseDir={defaultBaseDir} />
    </>
  );
}
