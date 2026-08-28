"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CopyPlus, Folder, FolderInput, Loader2, MoreHorizontal, Pencil, Play, Square, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ModelStatus, ModelView } from "@/server/modelsView";
import { formatSize } from "@/lib/format";
import { apiFetch } from "@/lib/api";
import { StartProgressDialog } from "../start-progress-dialog";

/**
 * 模型列表交互组件（M1 Task 7）：接收 server 侧装配好的分组数据，
 * 渲染按命名空间分组的表格；行操作（启动/停止）调
 * POST /api/v1/models/:name/{start,stop}，完成后 router.refresh() 重取
 * page 数据（实时性策略：动作触发刷新，不轮询）。
 *
 * ⋯ 菜单（M1 Task 12）：「移动空间」→ Dialog（目标空间 Select +「同时移动
 * 文件」checkbox，默认仅改分组不动物理文件）→ POST /api/v1/models/:name/move
 * → refresh。运行中模型的移动入口禁用（服务端 409 兜底）。编辑跳
 * /models/:name/edit。
 */

export interface ModelGroup {
  namespace: string;
  models: ModelView[];
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

/** 「移动空间」Dialog：目标空间 Select + 同时移动文件 checkbox（默认不移动） */
function MoveDialog({
  model,
  namespaces,
  open,
  onOpenChange,
}: {
  model: ModelView;
  /** 全部命名空间（page 传入；含当前空间，Select 里过滤掉） */
  namespaces: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("pages.models.moveDialog");
  const router = useRouter();
  const [target, setTarget] = useState<string | null>(null);
  const [moveFiles, setMoveFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const candidates = namespaces.filter((ns) => ns !== model.namespace);

  async function onConfirm() {
    if (target === null || busy) return;
    setBusy(true);
    setError(null);
    const res = await apiFetch(`/api/v1/models/${model.name}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ namespace: target, moveFiles }),
    }).catch(() => null);
    setBusy(false);

    if (res === null) {
      setError(t("errorNetwork"));
      return;
    }
    if (res.ok) {
      onOpenChange(false);
      router.refresh();
      return;
    }
    if (res.status === 409) setError(t("errorRunning"));
    else if (res.status === 404) setError(t("errorNotFound"));
    else if (res.status === 400) setError(t("errorBadRequest"));
    else setError(t("errorRequest"));
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {t("description", { model: model.displayName, namespace: model.namespace })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t("targetLabel")}</span>
            <Select
              value={target}
              onValueChange={(v) => setTarget(v === null ? null : String(v))}
            >
              <SelectTrigger className="w-full font-mono" aria-invalid={error !== undefined}>
                <SelectValue placeholder={t("targetPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((ns) => (
                  <SelectItem key={ns} value={ns}>
                    {ns}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={moveFiles}
              onChange={(e) => setMoveFiles(e.target.checked)}
              className="mt-0.5 size-3.5 shrink-0 accent-primary"
            />
            <span className="flex flex-col gap-0.5">
              <span>{t("moveFilesLabel")}</span>
              <span className="text-xs text-muted-foreground">{t("moveFilesHint")}</span>
            </span>
          </label>

          <p className="rounded-lg bg-muted/60 px-2.5 py-2 text-xs text-muted-foreground">
            {t("hint")}
          </p>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={busy} />}>
            {t("cancel")}
          </DialogClose>
          <Button disabled={target === null || busy} onClick={onConfirm}>
            {busy && <Loader2 className="animate-spin" />}
            {busy ? t("moving") : t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 单行：状态 / 模型 / 量化 / 大小（分片 ×N）/ 端口 / 启停 + 编辑 + ⋯ 菜单 */
function ModelRow({
  model,
  namespaces,
  runningName,
}: {
  model: ModelView;
  namespaces: string[];
  /** 当前运行的其他模型名：非空时本行 Start 语义为「切换」（服务端原子 stop+start） */
  runningName: string | null;
}) {
  const t = useTranslations("pages.models");
  const router = useRouter();
  const [pending, setPending] = useState<"start" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [startOpen, setStartOpen] = useState(false);

  const switchingFrom = runningName !== null && runningName !== model.name ? runningName : null;

  async function runAction(action: "start" | "stop") {
    setPending(action);
    setError(null);
    try {
      const res = await apiFetch(`/api/v1/models/${model.name}/${action}`, { method: "POST" });
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
        <div className="flex flex-col items-start gap-1">
          <StatusBadge status={model.status} />
          {model.configStale && (
            <Badge
              variant="outline"
              title={t("configStaleHint")}
              className="gap-1 border-amber-500/30 bg-amber-500/10 px-1.5 py-0 text-[10px] text-amber-600 dark:text-amber-400"
            >
              <TriangleAlert className="size-2.5!" />
              {t("configStale")}
            </Badge>
          )}
        </div>
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
      <TableCell className="w-[240px]">
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
                disabled={pending !== null || startOpen}
                onClick={() => setStartOpen(true)}
              >
                {pending === "start" ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Play className="size-3.5" />
                )}
                {pending === "start"
                  ? t("actionStarting")
                  : switchingFrom
                    ? t("actionSwitch")
                    : t("actionStart")}
              </Button>
            )}
            <Button variant="ghost" size="sm" nativeButton={false} render={<Link href={`/models/${model.name}/edit`} />}>
              <Pencil className="size-3.5" />
              {t("actionEdit")}
            </Button>
            {/* ⋯ 菜单（T12 移动空间 + 模板克隆）：另存为新模板不受运行状态限制（规格 §6.2，克隆只建配置行不碰容器/磁盘）；移动空间会动文件，运行中禁用（服务端 409 兜底） */}
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={t("actionMore")}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <MoreHorizontal className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-40">
                <DropdownMenuItem render={<Link href={`/models/${model.name}/duplicate`} />}>
                  <CopyPlus />
                  {t("actionDuplicate")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={model.status === "running"}
                  title={
                    model.status === "running" ? t("moveLockedRunning") : undefined
                  }
                  onClick={() => setMoveOpen(true)}
                >
                  <FolderInput />
                  {t("actionMove")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {error && <p className="text-xs whitespace-normal text-destructive">{error}</p>}
        </div>
        <MoveDialog model={model} namespaces={namespaces} open={moveOpen} onOpenChange={setMoveOpen} />
        {startOpen && (
          <StartProgressDialog
            onOpenChange={setStartOpen}
            modelName={model.name}
            displayName={model.displayName}
            switchingFrom={switchingFrom}
          />
        )}
      </TableCell>
    </TableRow>
  );
}

/** 命名空间分组表格：每组建一张 Card（分组头 + 表），底部附单模型约束说明 */
export function ModelsTable({ groups, namespaces }: { groups: ModelGroup[]; namespaces: string[] }) {
  const t = useTranslations("pages.models");

  // 当前运行模型名（切换语义用）：状态列全局唯一 running
  const runningName =
    groups.flatMap((g) => g.models).find((m) => m.status === "running")?.name ?? null;

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
                  <TableHead className="w-[240px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {group.models.map((model) => (
                  <ModelRow
                    key={model.name}
                    model={model}
                    namespaces={namespaces}
                    runningName={runningName}
                  />
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
