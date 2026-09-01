"use client";

import { useTranslations } from "next-intl";
import { CheckCircle2, HardDrive, Loader2, Save, TriangleAlert, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { findLocalImage, isCurrentImageSavable } from "@/lib/current-image";
import { formatSize } from "@/lib/format";
import type { ImagesResponseView } from "./image-types";

/**
 * 设置页「镜像管理」区块——当前启动镜像读数卡（规格
 * docs/superpowers/specs/2026-09-01-启动镜像可见性与自定义镜像列表-design.md §4）。
 *
 * 存在理由是规格 §1.1 那个缺陷：官方镜像表只有固定 8 个 variant，自定义列表只列
 * 本地已拉取的 tag——当前值两边都不匹配时（面板外 docker rmi、或从别的机器导入
 * 配置），「当前生效」徽标一行都不会出现，这个值在界面上彻底消失。而那正是最需要
 * 看见它的时候，因为下次启动模型必定失败。这张卡不依赖任何列表，只认
 * default_config.docker.image 本身，因此永远显示得出来。
 *
 * 本文件只负责渲染，草稿与写入由 image-card.tsx 持有（与另两张卡同构）。
 */
export function CurrentImageCard({
  draft,
  saved,
  catalog,
  saving,
  error,
  onDraftChange,
  onSave,
}: {
  draft: string;
  /** 已保存值：草稿与它不同才允许保存 */
  saved: string;
  /** null = 镜像清单还没到（首屏）；此时整条状态行不渲染，见下方注释 */
  catalog: ImagesResponseView | null;
  saving: boolean;
  /** 本卡自己那次保存的失败信息。两张列表按 ref 匹配行内展示错误，而这里填的 ref
   *  往往不对应任何一行，不单独接出来就会静默失败——点了保存什么都没发生 */
  error: string | null;
  onDraftChange: (value: string) => void;
  onSave: () => void;
}) {
  const t = useTranslations("pages.settings.image");

  const empty = draft.trim() === "";
  const savable = isCurrentImageSavable(draft, saved);
  const local = catalog === null ? null : findLocalImage(draft, catalog.localImages);

  return (
    <Card className="gap-0 py-0">
      <div className="flex flex-wrap items-center gap-2.5 border-b p-4">
        <HardDrive className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{t("currentImageTitle")}</h2>
      </div>

      <div className="flex flex-col gap-2 p-4">
        {/* A 级、常驻不收进悬停：不说这条，用户会困惑「我明明改了启动镜像，
            这个模型怎么还是用旧的」 */}
        <p className="text-sm text-foreground">{t("currentImageHint")}</p>

        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="max-w-lg font-mono text-xs"
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            aria-invalid={empty || undefined}
          />
          <Button size="sm" disabled={!savable || saving} onClick={onSave}>
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
            {saving ? t("saving") : t("currentImageSave")}
          </Button>
        </div>

        {/* 三态状态行。「本地没有」只提示不阻断——运行时 adapters/dockerode.ts 的
            createWithAutoPull 会在 404 时先 pull 再重试建容器，填一个还没拉的 ref
            是能工作的。catalog 未到位时整行不渲染，而不是渲染成「未拉取」——后者
            会在首屏加载的一瞬间报一个假警告 */}
        {empty ? (
          <p className="flex items-center gap-1.5 text-xs text-destructive">
            <TriangleAlert className="size-3.5 shrink-0" />
            {t("currentImageEmpty")}
          </p>
        ) : local !== null ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <CheckCircle2 className="size-3.5 shrink-0 text-accent-green" />
            {t("currentImagePulled", { size: formatSize(local.sizeBytes) })}
          </p>
        ) : catalog !== null ? (
          <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
            <TriangleAlert className="size-3.5 shrink-0" />
            {t("currentImageNotPulled")}
          </p>
        ) : null}

        {error !== null && (
          <p role="alert" className="flex items-center gap-1.5 text-xs text-destructive">
            <XCircle className="size-3.5 shrink-0" />
            {error}
          </p>
        )}
      </div>
    </Card>
  );
}
