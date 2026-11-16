"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";

import { NewDownloadDialog } from "@/components/downloads/new-download-dialog";
import { Button } from "@/components/ui/button";

/**
 * 文件页「新建下载」沿用统一弹层，并预选当前目录。
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
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" />
        {t("newDownloadButton")}
      </Button>
      <NewDownloadDialog open={open} onOpenChange={setOpen} folders={folders} defaultBaseDir={defaultBaseDir} />
    </>
  );
}
