"use client";

import { useState } from "react";
import { Download, Plus } from "lucide-react";
import { useTranslations } from "next-intl";

import { NewDownloadDialog } from "@/components/downloads/new-download-dialog";
import { Button } from "@/components/ui/button";

/** 仓库页只开放仓库入口，模型页同时开放仓库和 URL 下载。 */
export function RepoCreateNavButton({
  folders,
  repoOnly = false,
  variant = "default",
}: {
  folders: string[];
  repoOnly?: boolean;
  variant?: "default" | "outline";
}) {
  const t = useTranslations("pages");
  const [open, setOpen] = useState(false);
  const Icon = repoOnly ? Plus : Download;

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size="sm"
        onClick={() => setOpen(true)}
      >
        <Icon className="size-3.5" />
        {t(repoOnly ? "downloads.newDialog.repoTitle" : "models.downloadModel")}
      </Button>
      <NewDownloadDialog open={open} onOpenChange={setOpen} folders={folders} repoOnly={repoOnly} />
    </>
  );
}
