"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Folder, Loader2, Pencil, Play, Square, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";

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
import type { ModelStatus, ModelView } from "@/server/modelsView";

/**
 * 模型列表交互组件（M1 Task 7）：接收 server 侧装配好的分组数据，
 * 渲染按命名空间分组的表格；行操作（启动/停止）调
 * POST /api/v1/models/:name/{start,stop}，完成后 router.refresh() 重取
 * page 数据（实时性策略：动作触发刷新，不轮询）。
 *
 * ⋯ 菜单（移动空间/删除）留 T12；编辑跳 /models/:name/edit（路由 T8 落地，
 * 当前 404）。
 */

export interface ModelGroup {
  namespace: string;
  models: ModelView[];
}

/** 人类可读大小：≥1 GiB 用 GB（一位小数，≥100 取整），≥1 MiB 用 MB，否则 KB；无效值 "—" */
function formatSize(bytes: number): string {
  if (bytes <= 0) return "—";
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${gib >= 100 ? Math.round(gib) : gib.toFixed(1)} GB`;
  const mib = bytes / 1024 ** 2;
  if (mib >= 1) return `${mib.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** 状态徽标：running=绿点 / ready=灰点副文本 / missing-file=红 / missing-mmproj=amber */
function StatusBadge({ status }: { status: ModelStatus }) {
  const t = useTranslations("pages.models");
  switch (status) {
    case "running":
      return (
        <Badge
          variant="outline"
          className="gap-1.5 border-accent-green/25 bg-accent-green/10 text-accent-green"
        >
          <span className="size-1.5 rounded-full bg-accent-green" />
          {t("statusRunning")}
        </Badge>
      );
    case "missing-file":
      return (
        <Badge
          variant="outline"
          className="gap-1 border-accent-red/25 bg-accent-red/10 text-accent-red"
        >
          <TriangleAlert className="size-3!" />
          {t("statusMissingFile")}
        </Badge>
      );
    case "missing-mmproj":
      return (
        <Badge
          variant="outline"
          className="gap-1 border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
        >
          <TriangleAlert className="size-3!" />
          {t("statusMissingMmproj")}
        </Badge>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="size-1.5 rounded-full bg-muted-foreground/40" />
          {t("statusReady")}
        </span>
      );
  }
}

/** 单行：状态 / 模型 / 量化 / 大小（分片 ×N）/ 端口 / 启停 + 编辑 */
function ModelRow({ model }: { model: ModelView }) {
  const t = useTranslations("pages.models");
  const router = useRouter();
  const [pending, setPending] = useState<"start" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runAction(action: "start" | "stop") {
    setPending(action);
    setError(null);
    try {
      const res = await fetch(`/api/v1/models/${model.name}/${action}`, { method: "POST" });
      if (res.ok) {
        router.refresh();
        return;
      }
      if (res.status === 422) setError(t("errorMissingFile"));
      else if (res.status === 404) setError(t("errorNotFound"));
      else setError(t("errorRequest"));
    } catch {
      setError(t("errorRequest"));
    } finally {
      setPending(null);
    }
  }

  return (
    <TableRow>
      <TableCell className="w-[110px]">
        <StatusBadge status={model.status} />
      </TableCell>
      <TableCell>
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-mono text-[13px] font-semibold">{model.displayName}</span>
          <span className="truncate text-xs text-muted-foreground">{model.name}</span>
        </div>
      </TableCell>
      <TableCell className="w-[90px]">
        {model.quant ? (
          <Badge variant="outline" className="font-mono text-xs">
            {model.quant}
          </Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="w-[90px] font-mono text-[13px] tabular-nums">
        {model.fileCount === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <>
            {formatSize(model.sizeBytes)}
            {model.fileCount > 1 && (
              <span className="text-muted-foreground"> ×{model.fileCount}</span>
            )}
          </>
        )}
      </TableCell>
      <TableCell className="w-[80px] font-mono text-[13px] tabular-nums">
        :{model.hostPort}
      </TableCell>
      <TableCell className="w-[190px]">
        <div className="flex flex-col items-start gap-1">
          <div className="flex items-center gap-1">
            {model.status === "running" ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={pending !== null}
                onClick={() => runAction("stop")}
              >
                {pending === "stop" ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Square className="size-3.5" />
                )}
                {pending === "stop" ? t("actionStopping") : t("actionStop")}
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                disabled={pending !== null}
                onClick={() => runAction("start")}
              >
                {pending === "start" ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Play className="size-3.5" />
                )}
                {pending === "start" ? t("actionStarting") : t("actionStart")}
              </Button>
            )}
            <Button variant="ghost" size="sm" render={<Link href={`/models/${model.name}/edit`} />}>
              <Pencil className="size-3.5" />
              {t("actionEdit")}
            </Button>
          </div>
          {error && <p className="text-xs whitespace-normal text-destructive">{error}</p>}
        </div>
      </TableCell>
    </TableRow>
  );
}

/** 命名空间分组表格：每组建一张 Card（分组头 + 表），底部附单模型约束说明 */
export function ModelsTable({ groups }: { groups: ModelGroup[] }) {
  const t = useTranslations("pages.models");

  return (
    <div className="flex flex-col gap-3.5">
      {groups.map((group) => {
        const usedBytes = group.models.reduce((sum, m) => sum + m.sizeBytes, 0);
        return (
          <Card key={group.namespace} className="gap-0 py-0">
            <div className="flex items-center gap-2.5 border-b px-4 py-3">
              <Folder className="size-4 text-muted-foreground" />
              <span className="font-mono text-sm font-semibold">{group.namespace}</span>
              <span className="text-xs text-muted-foreground">
                {t("groupMeta", {
                  count: group.models.length,
                  size: formatSize(usedBytes),
                })}
              </span>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[110px]">{t("colStatus")}</TableHead>
                  <TableHead>{t("colModel")}</TableHead>
                  <TableHead className="w-[90px]">{t("colQuant")}</TableHead>
                  <TableHead className="w-[90px]">{t("colSize")}</TableHead>
                  <TableHead className="w-[80px]">{t("colPort")}</TableHead>
                  <TableHead className="w-[190px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {group.models.map((model) => (
                  <ModelRow key={model.name} model={model} />
                ))}
              </TableBody>
            </Table>
          </Card>
        );
      })}

      <p className="mt-1 text-xs text-muted-foreground">{t("footnote")}</p>
    </div>
  );
}
