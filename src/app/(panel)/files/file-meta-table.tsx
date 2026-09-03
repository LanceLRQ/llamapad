"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Hash,
  Layers,
  Loader2,
  MoreHorizontal,
  Pencil,
  Search,
  SortAsc,
  SortDesc,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useTranslations } from "next-intl";

import { truncateHash } from "@/lib/file-hash-line";
import { applyFileMetaQuery, type FileMetaQuery, type FileMetaSortDir, type FileMetaSortKey } from "@/lib/file-meta-list";
import { normalizeMetaField, QUANT_CANDIDATES, resolveQuantDisplay } from "@/lib/quant-labels";
import { formatSize } from "@/lib/format";
import { apiFetch } from "@/lib/api";
import { toast } from "@/components/toast-store";
import { Toolbar } from "@/components/shell/toolbar";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * 文件元信息表（T3b，设计 §3.5/§3.4/§3.6，消费 T3a 交付的 `/api/v1/file-meta*`；
 * M16 T6 从独立 Card 拍平成裸表——标题现在由 PageHeader 承担，命名空间那一维
 * 已经交给左侧二级栏的 "@meta" 格，这里只剩表格本体 + 上方 Toolbar）：与
 * files-table.tsx 并列的独立组件，而非合并进物理文件表——file_meta 一行是
 * 一个"逻辑条目"（单文件或分片组的 glob，§3.1），孤儿行（isOrphan）对应的
 * 物理文件已不存在，天然没有 scanTree 那边的行可以附着，分开建表最省事也
 * 最准确。
 *
 * 交互沿用 files-table.tsx 的既有范式：⋯ DropdownMenu 挂次要操作（编辑元信息 /
 * 计算校验和），Dialog 承载需要确认的操作（编辑表单 / 自动寻找候选 / 清理孤儿），
 * router.refresh() 拉取 server 端重新跑过 listFileMeta 的最新数据。
 *
 * 搜索 / 排序（M16 T6）：applyFileMetaQuery（lib/file-meta-list.ts）按完整
 * path 匹配关键字（不是 basename——这张表展示的就是含命名空间的完整路径）；
 * 排序只有 名称/大小 两项，没有修改时间（这张表本就没有这一列，摆一个不
 * 生效的选项不如不摆）。Toolbar 不传 chips（空数组）：files-table 的四个
 * 筛选切片（分片组/运行中占用/未被引用）跟元信息记录没有一一对应关系，
 * 摆一排不生效的假开关不如不摆。
 */

/** GET /api/v1/file-meta 的一行（与 server/fileMeta.ts FileMetaEntry 结构兼容，客户端不引 server 模块） */
export interface FileMetaEntryDto {
  id: number;
  path: string;
  isGroup: boolean;
  probePath: string;
  size: number | null;
  mtime: number | null;
  sampleSha256: string | null;
  fullSha256: string | null;
  quantLabel: string | null;
  detectedQuant: string | null;
  mark: string | null;
  isOrphan: boolean;
  createdAt: number;
  updatedAt: number;
}

/** POST /file-meta/locate 返回的候选（LocateCandidate 的传输形态） */
interface LocateCandidateDto {
  nextValue: string;
  probePath: string;
  size: number;
  mtime: number;
}

const QUANT_DATALIST_ID = "file-meta-quant-candidates";

/**
 * sha256 展示位（截断 + 悬停全值，§设计定稿）：FileMetaEntryDto 早就声明了
 * sampleSha256/fullSha256 两个字段，但改表全文件从没有渲染点——算完的哈希
 * 用户永远看不到，本任务补上。孤儿行不显示 full 段：文件已经不在磁盘上，
 * 完整哈希没有再算的可能，摆一个恒为"尚未计算"的段是噪音。
 */
function HashLine({ entry }: { entry: FileMetaEntryDto }) {
  const t = useTranslations("pages.files");
  const sample = truncateHash(entry.sampleSha256);

  if (entry.isOrphan) {
    // "保留，供自动寻找比对" 这句只有在 sample 真算出过值时才成立——sample
    // 本身也没算过（sample.short === null）就无所谓"保留供比对"，两句拼在
    // 一起（"尚未计算（保留，供自动寻找比对）"）自相矛盾，这种情况下不拼后缀
    return (
      <span className="block truncate font-mono text-[11px] text-muted-foreground opacity-82">
        <span title={sample.full ?? undefined}>
          {t("hashSampleLabel")} {sample.short ?? t("hashNotComputed")}
        </span>
        {sample.short !== null && t("hashKeptForLocate")}
      </span>
    );
  }

  const full = truncateHash(entry.fullSha256);
  return (
    <span className="block truncate font-mono text-[11px] text-muted-foreground opacity-82">
      <span title={sample.full ?? undefined}>
        {t("hashSampleLabel")} {sample.short ?? t("hashNotComputed")}
      </span>
      {" · "}
      <span title={full.full ?? undefined}>
        {t("hashFullLabel")} {full.short ?? t("hashNotComputed")}
      </span>
    </span>
  );
}

export function FileMetaTable({ entries }: { entries: FileMetaEntryDto[] }) {
  const t = useTranslations("pages.files");
  const router = useRouter();

  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  function setRowError(path: string, message: string | null) {
    setRowErrors((prev) => {
      const next = { ...prev };
      if (message === null) delete next[path];
      else next[path] = message;
      return next;
    });
  }

  // 搜索 / 排序（M16 T6）
  const [keyword, setKeyword] = useState("");
  const [sort, setSort] = useState<FileMetaSortKey>("name");
  const [dir, setDir] = useState<FileMetaSortDir>("asc");
  const query = useMemo<FileMetaQuery>(() => ({ keyword, sort, dir }), [keyword, sort, dir]);
  const visible = useMemo(() => applyFileMetaQuery(entries, query), [entries, query]);

  // 编辑元信息（quantLabel / mark 一起编辑一起保存）
  const [editDraft, setEditDraft] = useState<{ path: string; quant: string; mark: string } | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const editingEntry = editDraft === null ? null : (entries.find((e) => e.path === editDraft.path) ?? null);

  function onOpenEdit(entry: FileMetaEntryDto) {
    setEditError(null);
    setEditDraft({ path: entry.path, quant: entry.quantLabel ?? "", mark: entry.mark ?? "" });
  }

  async function onSaveEdit() {
    if (editDraft === null || editSaving) return;
    setEditSaving(true);
    setEditError(null);
    const res = await apiFetch("/api/v1/file-meta", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: editDraft.path,
        quantLabel: normalizeMetaField(editDraft.quant),
        mark: normalizeMetaField(editDraft.mark),
      }),
    }).catch(() => null);
    setEditSaving(false);

    if (res === null) {
      setEditError(t("errorNetwork"));
      return;
    }
    if (res.ok) {
      setEditDraft(null);
      router.refresh();
      toast.success(t("metaEditDone"));
      return;
    }
    setEditError(res.status === 404 ? t("metaErrorNotFound") : t("errorRequest"));
  }

  // 自动寻找（§3.4）：先 locate 拿候选，弹层里用户逐个确认才 relink，不静默改写
  const [locateLoadingPath, setLocateLoadingPath] = useState<string | null>(null);
  const [locateDraft, setLocateDraft] = useState<{ path: string; candidates: LocateCandidateDto[] } | null>(null);
  const [relinking, setRelinking] = useState(false);
  const [relinkError, setRelinkError] = useState<string | null>(null);

  async function onLocate(entry: FileMetaEntryDto) {
    if (locateLoadingPath !== null) return;
    setLocateLoadingPath(entry.path);
    setRowError(entry.path, null);
    const res = await apiFetch("/api/v1/file-meta/locate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: entry.path }),
    }).catch(() => null);
    setLocateLoadingPath(null);

    if (res === null) {
      setRowError(entry.path, t("errorNetwork"));
      return;
    }
    if (!res.ok) {
      setRowError(entry.path, res.status === 404 ? t("metaErrorNotFound") : t("errorRequest"));
      return;
    }
    const data = (await res.json().catch(() => null)) as { candidates: LocateCandidateDto[] } | null;
    setRelinkError(null);
    setLocateDraft({ path: entry.path, candidates: data?.candidates ?? [] });
  }

  async function onRelink(candidate: LocateCandidateDto) {
    if (locateDraft === null || relinking) return;
    setRelinking(true);
    setRelinkError(null);
    const res = await apiFetch("/api/v1/file-meta/relink", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: locateDraft.path, candidatePath: candidate.nextValue }),
    }).catch(() => null);
    setRelinking(false);

    if (res === null) {
      setRelinkError(t("errorNetwork"));
      return;
    }
    if (res.ok) {
      setLocateDraft(null);
      router.refresh();
      toast.success(t("locateDone", { path: candidate.nextValue }));
      return;
    }
    setRelinkError(res.status === 404 ? t("metaErrorNotFound") : t("metaErrorInvalid"));
  }

  // 手动计算完整哈希（D）：后台跑，路由 202 即返回，结果靠下次刷新可见
  const [checksumInFlight, setChecksumInFlight] = useState<string | null>(null);

  async function onChecksum(entry: FileMetaEntryDto) {
    if (checksumInFlight !== null) return;
    setChecksumInFlight(entry.path);
    const res = await apiFetch("/api/v1/file-meta/checksum", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: entry.path }),
    }).catch(() => null);
    setChecksumInFlight(null);

    if (res === null) {
      toast.error(t("errorNetwork"));
      return;
    }
    if (res.ok) {
      toast.info(t("checksumStarted"));
      return;
    }
    toast.error(t("errorRequest"));
  }

  // 清理孤儿记录（C）：批量操作，不逐行删
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const orphanCount = entries.filter((e) => e.isOrphan).length;

  async function onConfirmClearOrphans() {
    if (clearing) return;
    setClearing(true);
    const res = await apiFetch("/api/v1/file-meta/orphans", { method: "DELETE" }).catch(() => null);
    setClearing(false);
    setClearOpen(false);

    if (res === null) {
      toast.error(t("errorNetwork"));
      return;
    }
    if (!res.ok) {
      toast.error(t("errorRequest"));
      return;
    }
    const data = (await res.json().catch(() => null)) as { deleted: number } | null;
    router.refresh();
    toast.success(t("clearOrphansDone", { count: data?.deleted ?? 0 }));
  }

  return (
    // min-h-0 flex-1：拆成「固定的 Toolbar + 自己滚动的表格区」（反馈 4），
    // 与 models-table.tsx 同款改法
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar
        chips={[]}
        activeChip=""
        onChipChange={() => {}}
        note={{ shown: visible.length, total: entries.length }}
        search={{ value: keyword, onChange: setKeyword, placeholder: t("metaSearchPlaceholder") }}
        action={
          <>
            <Select value={sort} onValueChange={(v) => setSort(v as FileMetaSortKey)}>
              <SelectTrigger className="w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="name">{t("sortName")}</SelectItem>
                <SelectItem value="size">{t("sortSize")}</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="icon"
              aria-label={dir === "asc" ? t("sortAsc") : t("sortDesc")}
              title={dir === "asc" ? t("sortAsc") : t("sortDesc")}
              onClick={() => setDir((d) => (d === "asc" ? "desc" : "asc"))}
            >
              {dir === "asc" ? <SortAsc className="size-4" /> : <SortDesc className="size-4" />}
            </Button>
            {orphanCount > 0 && (
              <Button variant="outline" size="sm" onClick={() => setClearOpen(true)}>
                <Trash2 className="size-3.5" />
                {t("clearOrphansButtonCount", { count: orphanCount })}
              </Button>
            )}
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-5">
        <Table className="min-w-[860px]">
          <TableHeader>
            <TableRow>
              <TableHead>{t("colPath")}</TableHead>
              <TableHead className="w-[150px]">{t("colQuant")}</TableHead>
              <TableHead>{t("colMark")}</TableHead>
              <TableHead className="w-[90px]">{t("colSize")}</TableHead>
              <TableHead className="w-[190px]">{t("colStatus")}</TableHead>
              <TableHead className="w-[60px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((entry) => {
              const quant = resolveQuantDisplay(entry.quantLabel, entry.detectedQuant);
              return (
                <TableRow key={entry.path}>
                  <TableCell className="min-w-0 max-w-[220px]">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate break-all font-mono text-[13px]" title={entry.path}>
                          {entry.path}
                        </span>
                        {entry.isGroup && (
                          <Badge
                            variant="outline"
                            className="h-4.5 w-fit shrink-0 gap-1 px-1.5 font-sans text-[10px] leading-none text-muted-foreground"
                          >
                            <Layers className="size-2.5!" />
                            {t("fileMetaGroupBadge")}
                          </Badge>
                        )}
                      </div>
                      <HashLine entry={entry} />
                    </div>
                  </TableCell>
                  <TableCell>
                    {quant.value === null ? (
                      <span className="text-xs text-muted-foreground">{t("quantUnset")}</span>
                    ) : (
                      <Badge
                        variant={quant.source === "user" ? "secondary" : "outline"}
                        title={quant.source === "detected" ? t("quantDetectedTooltip") : undefined}
                        className="font-mono"
                      >
                        {quant.value}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="max-w-[170px]">
                    <span className="block truncate text-xs text-muted-foreground" title={entry.mark ?? undefined}>
                      {entry.mark ?? t("markEmpty")}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-[13px] tabular-nums">
                    {entry.size === null ? "—" : formatSize(entry.size)}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col items-start gap-1">
                      {entry.isOrphan ? (
                        <div className="flex items-center gap-1.5">
                          <Badge
                            variant="outline"
                            title={t("orphanTooltip")}
                            className="gap-1 border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                          >
                            <TriangleAlert className="size-3!" />
                            {t("orphanBadge")}
                          </Badge>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 px-2 text-xs"
                            // 没有采样哈希就没有比对基准，locateCandidates 会直接
                            // INVALID_VALUE 400，而这是个永久条件（文件已不在原路径，
                            // 采样哈希再也补不上了）。游离文件登记时不做采样探测
                            // （见 server/fileMeta.ts 的 probeSample），移动获取后
                            // 那一行原地变成孤儿，正是走到这里的常见路径
                            disabled={locateLoadingPath !== null || entry.sampleSha256 === null}
                            title={entry.sampleSha256 === null ? t("locateNoSample") : undefined}
                            onClick={() => onLocate(entry)}
                          >
                            {locateLoadingPath === entry.path ? (
                              <Loader2 className="size-3 animate-spin" />
                            ) : (
                              <Search className="size-3" />
                            )}
                            {t("actionLocate")}
                          </Button>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">{t("fileMetaOk")}</span>
                      )}
                      {rowErrors[entry.path] && (
                        <p className="text-xs whitespace-normal text-destructive">{rowErrors[entry.path]}</p>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        aria-label={t("actionMore")}
                        className="flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                      >
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-44">
                        <DropdownMenuItem onClick={() => onOpenEdit(entry)}>
                          <Pencil />
                          {t("actionEditMeta")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={checksumInFlight !== null || entry.isOrphan}
                          onClick={() => onChecksum(entry)}
                        >
                          <Hash />
                          {t("actionChecksum")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              );
            })}
            {visible.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="py-8 text-center text-xs text-muted-foreground">
                  {/* 与 files-table 同一套两分逻辑：整表本来就没有记录，与搜索
                      收窄到 0 条是两回事，指引方向不同 */}
                  {entries.length === 0 ? t("metaEmpty") : t("searchNoResults")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* 编辑元信息 Dialog：quantLabel 用下拉候选 + 自由文本组合框（datalist），
          草稿只从 quantLabel 初始化，绝不预填 detectedQuant（§3.5 明确禁止的行为） */}
      <Dialog
        open={editDraft !== null}
        onOpenChange={(open) => {
          if (!open && !editSaving) setEditDraft(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("metaEditTitle")}</DialogTitle>
            <DialogDescription>
              <span className="break-all font-mono text-xs">{editDraft?.path}</span>
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">{t("metaEditQuantLabel")}</span>
              <Input
                list={QUANT_DATALIST_ID}
                value={editDraft?.quant ?? ""}
                onChange={(e) =>
                  setEditDraft((prev) => (prev === null ? prev : { ...prev, quant: e.target.value }))
                }
                placeholder={t("metaEditQuantPlaceholder")}
                className="font-mono"
              />
              <datalist id={QUANT_DATALIST_ID}>
                {QUANT_CANDIDATES.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
              {editDraft !== null && editDraft.quant.trim() === "" && editingEntry?.detectedQuant && (
                <p className="text-xs text-muted-foreground">
                  {t("metaEditQuantDetectedHint", { value: editingEntry.detectedQuant })}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">{t("metaEditMarkLabel")}</span>
              <Textarea
                value={editDraft?.mark ?? ""}
                onChange={(e) =>
                  setEditDraft((prev) => (prev === null ? prev : { ...prev, mark: e.target.value }))
                }
                maxLength={500}
                placeholder={t("markPlaceholder")}
              />
            </div>

            {editError && <p className="text-xs text-destructive">{editError}</p>}
          </div>

          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={editSaving} />}>{t("cancel")}</DialogClose>
            <Button disabled={editSaving} onClick={onSaveEdit}>
              {editSaving && <Loader2 className="animate-spin" />}
              {editSaving ? t("metaEditSaving") : t("metaEditSave")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 自动寻找 Dialog（§3.4 第 4-5 步）：候选清单里逐个确认才 relink，无候选时如实告知 */}
      <Dialog
        open={locateDraft !== null}
        onOpenChange={(open) => {
          if (!open && !relinking) setLocateDraft(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("locateTitle")}</DialogTitle>
            <DialogDescription>
              <span className="break-all font-mono text-xs">{locateDraft?.path}</span>
            </DialogDescription>
          </DialogHeader>

          {locateDraft !== null && locateDraft.candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("locateEmpty")}</p>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-muted-foreground">{t("locateFoundPrompt")}</p>
              {locateDraft?.candidates.map((c) => (
                <div
                  key={c.nextValue}
                  className="flex items-center justify-between gap-2 rounded-lg border px-2.5 py-2"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate break-all font-mono text-xs">{c.nextValue}</span>
                    <span className="text-xs text-muted-foreground">
                      {t("locateCandidateSize", {
                        size: formatSize(c.size),
                        mtime: new Date(c.mtime).toLocaleString("sv-SE", {
                          year: "numeric",
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: false,
                        }),
                      })}
                    </span>
                  </div>
                  <Button size="sm" disabled={relinking} onClick={() => onRelink(c)}>
                    {relinking && <Loader2 className="animate-spin" />}
                    {t("locateConfirm")}
                  </Button>
                </div>
              ))}
            </div>
          )}

          {relinkError && <p className="text-xs text-destructive">{relinkError}</p>}

          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={relinking} />}>{t("cancel")}</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 清理孤儿记录确认 Dialog（§3.6）：只删 file_meta 行，不影响模型配置 */}
      <Dialog
        open={clearOpen}
        onOpenChange={(open) => {
          if (!open && !clearing) setClearOpen(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("clearOrphansConfirmTitle")}</DialogTitle>
            <DialogDescription>{t("clearOrphansConfirmDescription", { count: orphanCount })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={clearing} />}>{t("cancel")}</DialogClose>
            <Button variant="destructive" disabled={clearing} onClick={onConfirmClearOrphans}>
              {clearing && <Loader2 className="animate-spin" />}
              {clearing ? t("deleting") : t("clearOrphansButton")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
