"use client";

import Link from "next/link";
import { FolderX } from "lucide-react";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatSize } from "@/lib/format";

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
  /** 目录树内最新一次 mtime（毫秒）；decorateProfileStats 必然产出、
   *  GET /api/v1/repos 原样带出，本页排序不用它（服务端已排好），仅个别
   *  卡片（如首页「最近更新」区）会展示——同上，不声明只是靠「变量传参躲过
   *  TS 多余属性检查」，两侧类型一脱节就只能在运行时发现 */
  lastModified?: number;
}

export function RepoCard({ profile }: { profile: RepoProfileEntry }) {
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
