"use client";

import { useTranslations } from "next-intl";
import {
  Ban,
  CheckCircle2,
  Container,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
  Star,
  Trash2,
  TriangleAlert,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCreatedAt } from "@/lib/image-card-form";
import { formatSize } from "@/lib/format";
import { SettingTip } from "@/components/setting-tip";
import type { ImagesResponseView, ImageVariantView, LoadErrorCode, PullState } from "./image-types";

/**
 * 设置页「镜像管理」区块——官方 variant 清单卡片（T6 返工：从 image-card.tsx
 * 拆出，本文件只负责渲染 + 拉取进度展示，状态与动作全部由父组件
 * image-card.tsx 持有，本组件通过 props 拿到，不做任何自有状态）。
 *
 * 官方 server variant 固定清单：列表形态，按状态（当前生效/已在本地/未拉取）
 * 给操作入口；推荐项置顶但不锁定选择（§5.3），ROCm/MUSA/Intel/OpenVINO/s390x
 * 面板容器内测不到硬件，标注"需自行确认"且不参与推荐排序。
 */

/** 面板容器内无从探测硬件支持的平台，不参与推荐排序（§5.3） */
const UNVERIFIABLE_PLATFORMS = new Set(["rocm", "musa", "intel", "openvino", "s390x"]);

/** 状态徽标着色：绿=当前生效 / 主色=已在本地 / 灰=未拉取（对齐概览页运行状态配色） */
const STATUS_STYLE: Record<ImageVariantView["status"], { labelKey: string; className: string; dot?: boolean }> = {
  current: { labelKey: "statusCurrent", className: "gap-1 border-accent-green/25 bg-accent-green/10 text-accent-green", dot: true },
  local: { labelKey: "statusLocal", className: "border-primary/25 bg-primary/10 text-primary" },
  not_pulled: { labelKey: "statusNotPulled", className: "text-muted-foreground" },
};

export function OfficialImagesCard({
  initialImage,
  catalog,
  loadError,
  pull,
  busyRef,
  actionError,
  restartHint,
  startPull,
  setAsDefaultImage,
  requestDelete,
  abortPull,
}: {
  initialImage: string;
  catalog: ImagesResponseView | null;
  loadError: LoadErrorCode | null;
  pull: PullState | null;
  busyRef: string | null;
  actionError: { ref: string; message: string } | null;
  restartHint: boolean;
  startPull: (ref: string) => Promise<void>;
  setAsDefaultImage: (ref: string) => Promise<void>;
  requestDelete: (ref: string) => void;
  abortPull: () => void;
}) {
  const t = useTranslations("pages.settings.image");
  const tCommon = useTranslations("pages.settings");

  const anyPulling = pull?.phase === "pulling";

  // 推荐项置顶，其余保持声明顺序（Array.prototype.sort 稳定排序，§5.3："只影响排序与标记"）
  const sortedVariants = catalog
    ? [...catalog.variants].sort((a, b) => (a.recommended === b.recommended ? 0 : a.recommended ? -1 : 1))
    : [];

  return (
    <Card className="gap-0 py-0">
      <div className="flex flex-wrap items-center gap-2.5 border-b p-4">
        <Container className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{t("title")}</h2>
        <span className="text-xs text-muted-foreground">{t("description")}</span>
        {/* 面板拉的就是这个 GHCR 仓库，外链方便用户核对 tag 全集/发布说明 */}
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto"
          nativeButton={false}
          render={
            <a
              href="https://github.com/ggml-org/llama.cpp/pkgs/container/llama.cpp"
              target="_blank"
              rel="noreferrer noopener"
            />
          }
        >
          <ExternalLink className="size-3.5" />
          {t("officialLink")}
        </Button>
      </div>

      <div className="flex flex-col gap-3 p-4">
        {loadError && (
          <p className="flex items-center gap-1.5 text-xs text-destructive">
            <XCircle className="size-3.5 shrink-0" />
            {loadError === "network" ? tCommon("errorNetwork") : tCommon("errorRequest")}
          </p>
        )}

        {catalog === null && loadError === null && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            {t("loading")}
            <span className="font-mono">{initialImage}</span>
          </div>
        )}

        {catalog !== null && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colTag")}</TableHead>
                <TableHead className="w-[90px]">{t("colSize")}</TableHead>
                <TableHead className="w-[150px]">{t("colPulledAt")}</TableHead>
                <TableHead className="w-[110px]">{t("colStatus")}</TableHead>
                <TableHead className="w-[280px]">{t("colActions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedVariants.map((variant) => {
                const unverifiable = UNVERIFIABLE_PLATFORMS.has(variant.platform);
                const isCurrent = variant.status === "current";
                const isLocal = variant.local !== undefined;
                const isBusy = busyRef === variant.ref;
                const err = actionError?.ref === variant.ref ? actionError.message : null;
                const style = STATUS_STYLE[variant.status];
                return (
                  <TableRow key={variant.tag}>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-[13px] font-semibold">{variant.tag}</span>
                        <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">
                          {variant.platform}
                        </Badge>
                        {variant.recommended && (
                          <span className="flex items-center gap-1">
                            <Badge
                              variant="outline"
                              className="gap-1 border-primary/25 bg-primary/10 text-primary"
                            >
                              <Star className="size-3!" />
                              {t("recommendedBadge")}
                            </Badge>
                            <SettingTip text={t("recommendedHint")} />
                          </span>
                        )}
                        {unverifiable && (
                          <span className="flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
                            <TriangleAlert className="size-3" />
                            {t("unverifiedPlatformHint")}
                          </span>
                        )}
                      </div>
                      {err && <p className="mt-1 text-xs text-destructive">{err}</p>}
                    </TableCell>
                    <TableCell className="font-mono text-[13px] tabular-nums">
                      {variant.local ? formatSize(variant.local.size) : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                      {variant.local ? formatCreatedAt(variant.local.created) : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={style.className}>
                        {style.dot && <span className="size-1.5 rounded-full bg-accent-green" />}
                        {t(style.labelKey)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1">
                        {!isLocal && (
                          <Button size="sm" disabled={anyPulling || isBusy} onClick={() => void startPull(variant.ref)}>
                            <Download className="size-3.5" />
                            {t("pullButton")}
                          </Button>
                        )}
                        {isLocal && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={anyPulling || isBusy}
                            onClick={() => void startPull(variant.ref)}
                          >
                            <RefreshCw className="size-3.5" />
                            {t("updateButton")}
                          </Button>
                        )}
                        {isLocal && !isCurrent && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={anyPulling || isBusy}
                            onClick={() => void setAsDefaultImage(variant.ref)}
                          >
                            {isBusy ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
                            {t("setDefaultButton")}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          title={isCurrent ? t("deleteBlockedCurrentHint") : t("deleteButton")}
                          disabled={!isLocal || isCurrent || anyPulling || isBusy}
                          onClick={() => requestDelete(variant.ref)}
                        >
                          <Trash2 className="size-3.5" />
                          {t("deleteButton")}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}

        {pull && (
          <div className="flex flex-col gap-1.5 rounded-lg border px-3 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-xs font-medium">{pull.ref}</span>
              {pull.phase === "pulling" && (
                <Button variant="outline" size="xs" onClick={abortPull}>
                  <Ban className="size-3.5" />
                  {t("abortButton")}
                </Button>
              )}
            </div>

            {pull.phase === "pulling" && (
              <>
                <div className="flex items-center gap-3">
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                    {pull.snapshot?.percent != null ? (
                      <div
                        className="h-full rounded-full bg-primary transition-all duration-500"
                        style={{ width: `${Math.max(3, pull.snapshot.percent)}%` }}
                      />
                    ) : (
                      <div className="h-full w-full animate-pulse rounded-full bg-primary/40" />
                    )}
                  </div>
                  {pull.snapshot?.percent != null && (
                    <span className="font-mono text-xs tabular-nums text-muted-foreground">{pull.snapshot.percent}%</span>
                  )}
                </div>
                <span className="text-xs text-muted-foreground">
                  {pull.snapshot
                    ? t("layersProgress", { done: pull.snapshot.completedLayers, total: pull.snapshot.layers })
                    : t("pullStarting")}
                </span>
                {pull.snapshot?.status && <span className="text-xs text-muted-foreground">{pull.snapshot.status}</span>}
              </>
            )}

            {pull.phase === "done" && (
              <p className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="size-3.5 shrink-0" />
                {t("pullDone")}
              </p>
            )}
            {pull.phase === "error" && (
              <p className="flex items-center gap-1.5 text-xs text-destructive">
                <XCircle className="size-3.5 shrink-0" />
                {t("pullFail", { error: pull.message ?? "" })}
              </p>
            )}
            {pull.phase === "aborted" && (
              <p className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                <TriangleAlert className="size-3.5 shrink-0" />
                {t("pullAborted")}
              </p>
            )}
          </div>
        )}

        {restartHint && (
          <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-700 dark:text-amber-400">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span>{t("pullRestartHint")}</span>
          </div>
        )}
      </div>
    </Card>
  );
}
