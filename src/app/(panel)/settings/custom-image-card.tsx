"use client";

import { useTranslations } from "next-intl";
import { CheckCircle2, Loader2, Save, Trash2, TriangleAlert, Wrench, XCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { CustomDraft } from "@/lib/image-card-form";
import { formatCreatedAt } from "@/lib/image-card-form";
import { formatSize } from "@/lib/format";
import { StringArrayField } from "./string-array-field";
import type { ImagesResponseView, LoadErrorCode } from "./image-types";

/**
 * 设置页「镜像管理」区块——自定义镜像卡片（T6 返工：从 image-card.tsx 拆出，
 * 本文件只负责渲染，状态与动作全部由父组件 image-card.tsx 持有，本组件通过
 * props 拿到，不做任何自有状态）。
 *
 * 面向自备镜像 / 自行构建的进阶用法，规格决策 6："配错自负，不作推荐用法"。
 * 五字段（model_mount/entrypoint/extra_args/args_override/env）走
 * PUT /api/v1/settings/default_config 整体替换，读回原有 docker 段与之合并；
 * 留空即清空该键（交运行时兜底），不是显式写入空数组/空串——归一化逻辑见
 * lib/image-card-form.ts draftToPatch。
 */

export function CustomImageCard({
  catalog,
  draft,
  customLoadError,
  customDirty,
  customSaving,
  customError,
  anyPulling,
  busyRef,
  actionError,
  updateDraft,
  saveCustom,
  setAsDefaultImage,
  requestDelete,
}: {
  catalog: ImagesResponseView | null;
  draft: CustomDraft | null;
  customLoadError: LoadErrorCode | null;
  customDirty: boolean;
  customSaving: boolean;
  customError: string | null;
  anyPulling: boolean;
  busyRef: string | null;
  actionError: { ref: string; message: string } | null;
  updateDraft: (patch: Partial<CustomDraft>) => void;
  saveCustom: () => Promise<void>;
  setAsDefaultImage: (ref: string) => Promise<void>;
  requestDelete: (ref: string) => void;
}) {
  const t = useTranslations("pages.settings.image");
  const tCommon = useTranslations("pages.settings");

  // 本地已拉取但不在官方清单里的 tag：自定义镜像通道的"已拉取"展示（一个镜像可能有多个 tag，
  // 逐个非官方 tag 各生成一行，官方 tag 已在官方清单卡片出现，这里跳过避免重复）
  const officialRefs = new Set(catalog?.variants.map((v) => v.ref) ?? []);
  const customImages = (catalog?.localImages ?? []).flatMap((img) =>
    img.tags.filter((tag) => !officialRefs.has(tag)).map((tag) => ({ id: img.id, tag, size: img.size, created: img.created })),
  );

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2.5 border-b px-4 py-3">
        <Wrench className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{t("customTitle")}</h2>
      </div>

      <div className="flex flex-col gap-4 px-4 py-3.5">
        <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-700 dark:text-amber-400">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{t("customAdvancedWarning")}</span>
        </div>

        {customLoadError && (
          <p className="flex items-center gap-1.5 text-xs text-destructive">
            <XCircle className="size-3.5 shrink-0" />
            {customLoadError === "network" ? tCommon("errorNetwork") : tCommon("errorRequest")}
          </p>
        )}

        {draft === null && customLoadError === null && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            {t("loading")}
          </div>
        )}

        {draft !== null && (
          <>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs font-medium">{t("fieldModelMount")}</Label>
              {/* A 级：挂载路径需与镜像约定一致，配错代价高，不做灰色小字 */}
              <p className="text-sm text-foreground">{t("modelMountHint")}</p>
              <Input
                className="max-w-xs font-mono text-xs"
                placeholder="/models"
                value={draft.model_mount}
                onChange={(e) => updateDraft({ model_mount: e.target.value })}
              />
            </div>

            <StringArrayField
              label={t("fieldEntrypoint")}
              tip={t("entrypointHint")}
              values={draft.entrypoint}
              addLabel={t("addRow")}
              onChange={(next) => updateDraft({ entrypoint: next })}
            />
            <StringArrayField
              label={t("fieldExtraArgs")}
              tip={t("extraArgsHint")}
              values={draft.extra_args}
              addLabel={t("addRow")}
              onChange={(next) => updateDraft({ extra_args: next })}
            />

            <div className="flex flex-col gap-1.5">
              {/* A 级：整体取代面板参数、悬空标志需自保，配错代价高，走 warning 常驻 */}
              <StringArrayField
                label={t("fieldArgsOverride")}
                warning={t("argsOverrideHint")}
                values={draft.args_override}
                addLabel={t("addRow")}
                onChange={(next) => updateDraft({ args_override: next })}
              />
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                <span className="font-medium">{t("argsOverridePlaceholdersLabel")}</span>
                <span className="font-mono">{"{{model_path}}"}</span>
                <span>{t("argsOverridePlaceholderModel")}</span>
                <span className="font-mono">{"{{mmproj_path}}"}</span>
                <span>{t("argsOverridePlaceholderMmproj")}</span>
                <span className="font-mono">{"{{port}}"}</span>
                <span>{t("argsOverridePlaceholderPort")}</span>
              </div>
            </div>

            <StringArrayField
              label={t("fieldEnv")}
              tip={t("envHint")}
              values={draft.env}
              addLabel={t("addRow")}
              onChange={(next) => updateDraft({ env: next })}
            />

            <div className="flex flex-wrap items-center gap-3 border-t pt-3.5">
              <Button size="sm" disabled={!customDirty || customSaving} onClick={() => void saveCustom()}>
                {customSaving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                {customSaving ? t("saving") : t("saveButton")}
              </Button>
              {customError && <p className="text-xs text-destructive">{customError}</p>}
            </div>
          </>
        )}

        <div className="flex flex-col gap-2 border-t pt-3.5">
          <h3 className="text-xs font-semibold text-muted-foreground">{t("localCustomImagesTitle")}</h3>
          {customImages.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("localCustomImagesEmpty")}</p>
          ) : (
            // 自定义镜像数量没有上限（用户能一直 pull 新 tag），用 max-h + 内部
            // 滚动兜住；max-h 而非 h——条目少时写死高度会留一截空白
            <div className="max-h-72 overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("colTag")}</TableHead>
                    <TableHead className="w-[90px]">{t("colSize")}</TableHead>
                    <TableHead className="w-[150px]">{t("colPulledAt")}</TableHead>
                    <TableHead className="w-[220px]">{t("colActions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {customImages.map((row) => {
                    const isCurrent = row.tag === catalog?.currentImage;
                    const isBusy = busyRef === row.tag;
                    const err = actionError?.ref === row.tag ? actionError.message : null;
                    return (
                      <TableRow key={`${row.id}-${row.tag}`}>
                        <TableCell className="font-mono text-[13px]">{row.tag}</TableCell>
                        <TableCell className="font-mono text-[13px] tabular-nums">{formatSize(row.size)}</TableCell>
                        <TableCell className="font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                          {formatCreatedAt(row.created)}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap items-center gap-1">
                            {isCurrent ? (
                              <Badge variant="outline" className="gap-1 border-accent-green/25 bg-accent-green/10 text-accent-green">
                                <span className="size-1.5 rounded-full bg-accent-green" />
                                {t("statusCurrent")}
                              </Badge>
                            ) : (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={anyPulling || isBusy}
                                onClick={() => void setAsDefaultImage(row.tag)}
                              >
                                {isBusy ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
                                {t("setDefaultButton")}
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              title={isCurrent ? t("deleteBlockedCurrentHint") : t("deleteButton")}
                              disabled={isCurrent || anyPulling || isBusy}
                              onClick={() => requestDelete(row.tag)}
                            >
                              <Trash2 className="size-3.5" />
                              {t("deleteButton")}
                            </Button>
                          </div>
                          {err && <p className="mt-1 text-xs text-destructive">{err}</p>}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
