"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FilePlus2, FolderInput, Link2, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { fileName } from "@/lib/file-list";
import { folderOfRel } from "@/lib/files-tree";
import { formatSize } from "@/lib/format";
import type { UnclaimedFile } from "@/lib/unclaimed-view";
import { apiFetch } from "@/lib/api";
import { toast } from "@/components/toast-store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * 未登记文件表（任务 18，设计 §9.3）：全库游离 .gguf 文件（refs===0，
 * lib/unclaimed-view.ts 的 deriveUnclaimed 派生），page.tsx 已经在 SSR
 * 阶段算好整个数组直接传入——与二级栏「未登记」格子的计数同一份数据，
 * 不再另发一次 GET /api/v1/files/unclaimed（那个接口留给别处按需拉取，
 * 比如日后要做的客户端刷新）。
 *
 * 每行只有两个动作：
 * - 建配置：复用向导已通的 `?file=&step=2` 深链（files-table.tsx 同款），
 *   纯跳转，不需要确认——这里不会误删/误改任何东西
 * - 归位到档案：选目标档案目录后 POST /api/v1/files/move。已经在档案目录
 *   内的行（inRepoDir !== null）禁用此按钮——planFileMove 服务端拒绝把
 *   档案目录内的文件单独移出（server/filesApi.ts 的档案目录守卫），点了
 *   必然 400，禁用是省一次注定失败的往返，不是唯一防线
 *
 * 删除入口不在这里：游离文件与普通文件共用 files-table.tsx 那一套删除
 * 确认框（含「与 X 共用」的磁盘空间提示），用户切到文件所在文件夹删除
 * 即可，不必在这张表里重开一套。
 */
export function UnclaimedTable({
  files,
  repoDirs,
}: {
  files: UnclaimedFile[];
  repoDirs: readonly string[];
}) {
  const t = useTranslations("pages.files");
  const router = useRouter();

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

  const [moveDraft, setMoveDraft] = useState<UnclaimedFile | null>(null);
  const [moveTarget, setMoveTarget] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);

  function onOpenMove(file: UnclaimedFile): void {
    setMoveTarget(null);
    setMoveError(null);
    setMoveDraft(file);
  }

  /** 与 files-table.tsx 的 guardErrorMessage 同一套 `{ error: CODE }` 契约。
   * 保留 LOCKED 分支：这个文件本身 refs===0，但若它是分片组的一员、组内
   * 其他分片已被运行中模型引用，planFileMove 按整组算 refs，仍可能锁定。 */
  function guardErrorMessage(code: string | undefined): string {
    switch (code) {
      case "LOCKED":
        return t("errorLocked");
      case "CONFLICT":
        return t("moveErrorConflict");
      case "NOT_FOUND":
        return t("errorNotFound");
      case "INVALID_PATH":
        return t("moveErrorInvalid");
      default:
        return t("errorRequest");
    }
  }

  async function onConfirmMove(): Promise<void> {
    if (moveDraft === null || moveTarget === null || moving) return;
    setMoving(true);
    setMoveError(null);
    const res = await apiFetch("/api/v1/files/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: moveDraft.rel, toFolder: moveTarget }),
    }).catch(() => null);
    setMoving(false);

    if (res === null) {
      setMoveError(t("errorNetwork"));
      return;
    }
    if (res.ok) {
      const name = fileName(moveDraft.rel);
      setMoveDraft(null);
      router.refresh();
      toast.success(t("moveDone", { name }));
      return;
    }
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    setMoveError(guardErrorMessage(body?.error));
  }

  const moveCandidates = moveDraft === null ? [] : repoDirs.filter((d) => d !== folderOfRel(moveDraft.rel));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border/50 px-7 py-2 text-xs text-muted-foreground">
        {t("unclaimedSummary", { count: files.length, size: formatSize(totalBytes) })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-5">
        <Table className="min-w-[760px]">
          <TableHeader>
            <TableRow>
              <TableHead>{t("colFile")}</TableHead>
              <TableHead className="w-[90px]">{t("colSize")}</TableHead>
              <TableHead>{t("colFolder")}</TableHead>
              <TableHead />
              <TableHead className="w-[220px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {files.map((file) => {
              const folder = folderOfRel(file.rel);
              return (
                <TableRow key={file.rel}>
                  <TableCell className="min-w-0 max-w-[260px]">
                    <span className="block truncate break-all font-mono text-[13px]" title={file.rel}>
                      {fileName(file.rel)}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-[13px] tabular-nums">{formatSize(file.size)}</TableCell>
                  <TableCell className="max-w-[220px]">
                    <span className="block truncate font-mono text-xs text-muted-foreground" title={folder}>
                      {folder === "" ? t("rootTitle") : folder}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1">
                      <Badge
                        variant="outline"
                        className="h-4.5 w-fit px-1.5 font-sans text-[10px] leading-none text-muted-foreground"
                      >
                        {file.inRepoDir !== null ? t("unclaimedBadgeInRepo") : t("unclaimedBadgeLoose")}
                      </Badge>
                      {file.hasMeta && (
                        <Badge
                          variant="outline"
                          className="h-4.5 w-fit px-1.5 font-sans text-[10px] leading-none text-muted-foreground"
                        >
                          {t("unclaimedBadgeHasMeta")}
                        </Badge>
                      )}
                      {file.sharedWith.length > 0 && (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Badge
                                variant="outline"
                                aria-label={file.sharedWith
                                  .map((p) => t("unclaimedSharedWith", { path: p }))
                                  .join(" / ")}
                                className="h-4.5 w-fit gap-1 px-1 font-sans text-[10px] leading-none text-muted-foreground"
                              />
                            }
                          >
                            <Link2 className="size-2.5!" />
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs break-all">
                            {file.sharedWith.map((p) => (
                              <span key={p} className="mt-0.5 block font-mono">
                                {t("unclaimedSharedWith", { path: p })}
                              </span>
                            ))}
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1.5">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => router.push(`/models/new?file=${encodeURIComponent(file.rel)}&step=2`)}
                      >
                        <FilePlus2 className="size-3.5" />
                        {t("unclaimedActionCreate")}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        disabled={file.inRepoDir !== null || repoDirs.length === 0}
                        title={
                          file.inRepoDir !== null
                            ? t("unclaimedRelocateDisabled")
                            : repoDirs.length === 0
                              ? t("unclaimedRelocateNoRepo")
                              : undefined
                        }
                        onClick={() => onOpenMove(file)}
                      >
                        <FolderInput className="size-3.5" />
                        {t("unclaimedActionRelocate")}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {files.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="py-8 text-center text-xs text-muted-foreground">
                  {t("unclaimedEmpty")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* 归位到档案确认 Dialog：目标 Select 只列档案目录（repoDirs），与
          files-table.tsx 的移动 Dialog 同一套交互，但没有引用清单可展示——
          游离文件的定义就是 refs === 0 */}
      <Dialog
        open={moveDraft !== null}
        onOpenChange={(open) => {
          if (!open && !moving) setMoveDraft(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("unclaimedActionRelocate")}</DialogTitle>
            <DialogDescription>
              <span className="break-all font-mono text-xs">{moveDraft?.rel}</span>
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">{t("moveTargetLabel")}</span>
              <Select value={moveTarget} onValueChange={(v) => setMoveTarget(v === null ? null : String(v))}>
                <SelectTrigger className="w-full font-mono">
                  <SelectValue placeholder={t("moveTargetPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {moveCandidates.map((d) => (
                    <SelectItem key={d} value={d}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {moveError && <p className="text-xs text-destructive">{moveError}</p>}
          </div>

          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={moving} />}>{t("cancel")}</DialogClose>
            <Button disabled={moveTarget === null || moving} onClick={onConfirmMove}>
              {moving && <Loader2 className="animate-spin" />}
              {moving ? t("moving") : t("confirmMove")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
