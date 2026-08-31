"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Check, FilePlus2, Loader2, Plus, TriangleAlert } from "lucide-react";

import { NamespaceCreateDialog } from "@/components/namespace-create-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiFetch } from "@/lib/api";
import {
  archiveMmprojFile,
  batchCreateCandidates,
  buildCreateModelBody,
  classifyCreateResult,
  type BatchCandidate,
} from "@/lib/batch-create";
import { formatSize } from "@/lib/format";
import type { RepoRow } from "@/lib/repo-files-view";

/**
 * 档案详情页「批量创建配置」（任务 11）：把 mergeRepoRows 已经算好的候选行
 * （src/lib/batch-create.ts）铺成一张可编辑表格，逐条串行 POST /api/v1/models
 * ——同一时刻只有一个管理员在用面板，串行是为了避免并发写 SQLite，不是
 * 性能考虑。
 *
 * 候选与预填在打开弹层那一刻算一次（handleOpenChange），此后不再随
 * `rows` prop 变化重算：父组件在批量提交过程中可能因为别的原因重新
 * fetchDetails，若这里跟着重算会把用户正在编辑的名字/勾选状态冲掉。
 */
export function BatchCreateDialog({
  repo,
  rows,
  onCreated,
}: {
  repo: string;
  rows: RepoRow[];
  onCreated: () => void;
}) {
  const t = useTranslations("pages.repos.batchCreate");
  const tRepos = useTranslations("pages.repos");
  const [open, setOpen] = useState(false);
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [namespace, setNamespace] = useState("main");
  const [nsDialogOpen, setNsDialogOpen] = useState(false);
  const [mmprojFile, setMmprojFile] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ tone: "error" | "info"; text: string } | null>(null);

  const eligible = batchCreateCandidates(repo, rows);

  function handleOpenChange(next: boolean): void {
    if (busy) return;
    if (next) {
      const mmproj = archiveMmprojFile(rows);
      setMmprojFile(mmproj);
      setDrafts(eligible.map((c) => toDraftRow(c, mmproj !== null)));
      setBanner(null);
      apiFetch("/api/v1/namespaces", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { namespaces: { name: string }[] } | null) => {
          if (d === null) return;
          const names = d.namespaces.map((n) => n.name);
          setNamespaces(names);
          setNamespace((prev) => (names.includes(prev) ? prev : (names[0] ?? "main")));
        })
        .catch(() => {
          // 命名空间清单拉取失败不阻塞弹层：默认落在 "main"，用户仍可手动
          // 通过下方「新建命名空间」现建一个
        });
    }
    setOpen(next);
  }

  function updateDraft(index: number, patch: Partial<DraftRow>): void {
    setDrafts((prev) => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  }

  function handleNamespaceCreated(name: string): void {
    setNamespaces((prev) => (prev.includes(name) ? prev : [...prev, name].sort()));
    setNamespace(name);
  }

  const selectedCount = drafts.filter((d) => d.selected && d.status !== "success").length;

  async function onSubmit(): Promise<void> {
    if (busy || selectedCount === 0) return;
    setBusy(true);
    setBanner(null);

    // 用局部数组承接每一行的最终状态，循环末尾一次性 setDrafts——循环内
    // await 之间穿插多次 setState 排队更新，读到的会是本轮渲染开始时的
    // 旧闭包，不是上一次迭代刚写入的值
    const next = [...drafts];
    let successCount = 0;
    let conflictCount = 0;
    let stopReason: string | null = null;

    for (let i = 0; i < next.length; i++) {
      const row = next[i]!;
      if (!row.selected || row.status === "success") continue;

      const body = buildCreateModelBody(row, {
        name: row.name,
        displayName: row.displayName,
        namespace,
        mmprojFile: row.attachMmproj ? mmprojFile : null,
      });
      const res = await apiFetch("/api/v1/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => null);

      const outcome = classifyCreateResult(res?.status ?? null);
      if (outcome === "success") {
        successCount += 1;
        next[i] = { ...row, status: "success" };
        continue;
      }
      if (outcome === "conflict") {
        conflictCount += 1;
        next[i] = { ...row, status: "conflict" };
        continue;
      }

      // stop：网络中断没有响应体可读，其余情况尽量把服务端给的原因亮出来
      const reason =
        res === null
          ? t("errorNetwork")
          : ((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? t("errorRequest");
      stopReason = t("stopped", { count: successCount, name: row.name, reason });
      break;
    }

    setDrafts(next);
    setBusy(false);

    if (stopReason !== null) {
      setBanner({ tone: "error", text: stopReason });
    } else if (conflictCount > 0) {
      setBanner({ tone: "info", text: t("summaryPartial", { success: successCount, conflict: conflictCount }) });
    } else if (successCount > 0) {
      setOpen(false);
    }
    if (successCount > 0) onCreated();
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={eligible.length === 0}
        title={eligible.length === 0 ? tRepos("batchCreateNoneEligible") : undefined}
        onClick={() => handleOpenChange(true)}
      >
        <FilePlus2 className="size-3.5" />
        {tRepos("batchCreateConfigs")}
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>{t("description", { repo })}</DialogDescription>
          </DialogHeader>

          <div className="flex items-end gap-2">
            <div className="flex flex-1 flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">{t("namespaceLabel")}</span>
              <Select value={namespace} onValueChange={(v) => setNamespace(String(v))}>
                <SelectTrigger className="w-full" disabled={busy}>
                  <SelectValue>{(v: string) => v}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {namespaces.map((ns) => (
                    <SelectItem key={ns} value={ns}>
                      {ns}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              disabled={busy}
              title={t("newNamespaceTitle")}
              aria-label={t("newNamespaceTitle")}
              onClick={() => setNsDialogOpen(true)}
            >
              <Plus className="size-3.5" />
            </Button>
          </div>

          <div className="max-h-[50vh] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <span className="sr-only">{t("colSelect")}</span>
                  </TableHead>
                  <TableHead className="w-[110px]">{t("colQuant")}</TableHead>
                  <TableHead>{t("colName")}</TableHead>
                  <TableHead>{t("colDisplayName")}</TableHead>
                  {mmprojFile !== null && <TableHead className="w-[110px]">{t("colMmproj")}</TableHead>}
                  <TableHead className="w-[150px]">{t("colStatus")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {drafts.map((draft, index) => (
                  <DraftTableRow
                    key={draft.key}
                    draft={draft}
                    showMmproj={mmprojFile !== null}
                    disabled={busy}
                    onChange={(patch) => updateDraft(index, patch)}
                  />
                ))}
              </TableBody>
            </Table>
          </div>

          {banner !== null && (
            <div
              role="alert"
              className={
                banner.tone === "error"
                  ? "flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
                  : "flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-700 dark:text-amber-400"
              }
            >
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0 break-words">{banner.text}</span>
            </div>
          )}

          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={busy} />}>{t("cancel")}</DialogClose>
            <Button disabled={busy || selectedCount === 0} onClick={() => void onSubmit()}>
              {busy && <Loader2 className="animate-spin" />}
              {busy ? t("submitting") : t("submit", { count: selectedCount })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <NamespaceCreateDialog open={nsDialogOpen} onOpenChange={setNsDialogOpen} onCreated={handleNamespaceCreated} />
    </>
  );
}

/** 表格里一条可编辑候选行的状态：selected/name/displayName/attachMmproj
 *  可编辑，status 由提交流程写入，success 之后整行只读（已建好，改名字
 *  也不会再重复提交） */
interface DraftRow extends BatchCandidate {
  selected: boolean;
  name: string;
  displayName: string;
  attachMmproj: boolean;
  status: "pending" | "success" | "conflict";
}

function toDraftRow(candidate: BatchCandidate, mmprojAvailable: boolean): DraftRow {
  return {
    ...candidate,
    selected: true,
    attachMmproj: mmprojAvailable,
    status: "pending",
  };
}

function DraftTableRow({
  draft,
  showMmproj,
  disabled,
  onChange,
}: {
  draft: DraftRow;
  showMmproj: boolean;
  disabled: boolean;
  onChange: (patch: Partial<DraftRow>) => void;
}) {
  const t = useTranslations("pages.repos.batchCreate");
  const tRepos = useTranslations("pages.repos");
  const rowDisabled = disabled || draft.status === "success";

  return (
    <TableRow>
      <TableCell>
        <Checkbox
          checked={draft.selected}
          disabled={rowDisabled}
          onCheckedChange={(checked) => onChange({ selected: checked === true })}
        />
      </TableCell>
      <TableCell className="font-mono text-xs">
        <div>{draft.quant ?? tRepos("unknownQuant")}</div>
        <div className="text-muted-foreground">{formatSize(draft.totalSize)}</div>
      </TableCell>
      <TableCell>
        <Input
          className="font-mono"
          value={draft.name}
          disabled={rowDisabled}
          aria-invalid={draft.status === "conflict" || undefined}
          onChange={(e) => onChange({ name: e.target.value, status: "pending" })}
        />
        {draft.status === "conflict" && (
          <p className="pt-1 text-xs text-destructive">{t("statusConflict")}</p>
        )}
      </TableCell>
      <TableCell>
        <Input
          value={draft.displayName}
          disabled={rowDisabled}
          onChange={(e) => onChange({ displayName: e.target.value })}
        />
      </TableCell>
      {showMmproj && (
        <TableCell>
          <Checkbox
            checked={draft.attachMmproj}
            disabled={rowDisabled}
            onCheckedChange={(checked) => onChange({ attachMmproj: checked === true })}
          />
        </TableCell>
      )}
      <TableCell>
        {draft.status === "success" && (
          <span className="flex items-center gap-1.5 text-sm text-accent-green">
            <Check className="size-3.5" />
            {t("statusSuccess")}
          </span>
        )}
      </TableCell>
    </TableRow>
  );
}
