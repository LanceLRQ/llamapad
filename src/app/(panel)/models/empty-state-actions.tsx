"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Plus } from "lucide-react";
import { useTranslations } from "next-intl";

import { NewDownloadDialog } from "@/components/downloads/new-download-dialog";
import { Button } from "@/components/ui/button";

/**
 * 模型页空态的两个动作（I7 修复），结构照抄 files/new-download-button.tsx
 * 那份薄包装（共享弹层本体不关心从哪个页面唤起，差异收在这层）：
 *
 * - 主按钮「新建下载」：唤起统一弹层，对应磁盘上还没有任何 gguf 的全新安装
 * - 次按钮「从已有文件新建配置」：保留 Link 到 /models/new，对应磁盘上已有
 *   gguf、只是还没建过配置的场景
 *
 * 两个都要留：`models.length === 0` 时整张 ModelsTable（含工具条里那个
 * 常驻的新建配置入口）不渲染，若只留下载按钮，向导入口在空态下会彻底消失。
 */
export function ModelsEmptyStateActions({ folders }: { folders: string[] }) {
  const t = useTranslations("pages.models");
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-1 flex items-center gap-2">
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" />
        {t("emptyAction")}
      </Button>
      <Button size="sm" variant="outline" nativeButton={false} render={<Link href="/models/new" />}>
        {t("emptyActionSecondary")}
        <ArrowRight className="size-3.5" />
      </Button>
      <NewDownloadDialog open={open} onOpenChange={setOpen} folders={folders} />
    </div>
  );
}
