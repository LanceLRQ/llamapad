"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CopyPlus, FolderInput, Loader2, MoreHorizontal, Pencil, Play, Plus, Square, Tag, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";

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
import { computeChipCounts } from "@/lib/toolbar-counts";
import { StartProgressDialog } from "../start-progress-dialog";

/**
 * 模型列表交互组件（M1 Task 7）：接收 server 侧按选中命名空间过滤好的模型
 * 列表，渲染一张表（不再是每命名空间一张 Card——M16 T5 拍平，命名空间那一维
 * 已经交给左侧二级栏切片）；行操作（启动/停止）调 POST
 * /api/v1/models/:name/{start,stop}，完成后 router.refresh() 重取 page 数据
 * （实时性策略：动作触发刷新，不轮询）。
 *
 * ⋯ 菜单（M1 Task 12；阶段 1b B6 拆分）：命名空间与文件夹解耦后，「移动
 * 空间」拆成两个独立操作——「改命名空间」（Dialog：目标空间 Select）→
 * POST /api/v1/models/:name/move，纯改分组标签，绝不动文件；「移动文件
 * 到…」（Dialog：目标文件夹 Select，取自磁盘既有目录）→
 * POST /api/v1/models/:name/move-files，只搬物理文件，绝不改命名空间。
 * 两者完成后都 router.refresh()；运行中模型两个入口均禁用（服务端 409/423
 * 兜底）。编辑跳 /models/:name/edit。
 *
 * 状态筛选 + 搜索（M16 T5）：Toolbar 挂在表格上方，chip 计数走
 * computeChipCounts——务必传"当前切片的全量模型"而非已按 chip 过滤后的可见
 * 列表（否则其余 chip 会在当前筛选口径下归零，参见 lib/toolbar-counts.ts）。
 */

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

/** 「改命名空间」Dialog：目标空间 Select，纯改分组标签，绝不动物理文件 */
function MoveNamespaceDialog({
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
      body: JSON.stringify({ namespace: target }),
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

/** 「移动文件到…」Dialog：目标文件夹 Select（磁盘既有一级目录），只搬物理文件，绝不改命名空间 */
function MoveFilesDialog({
  model,
  folders,
  open,
  onOpenChange,
}: {
  model: ModelView;
  /** 磁盘全部一级目录（page 传入；含模型当前所在文件夹，Select 里过滤掉） */
  folders: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("pages.models.moveFilesDialog");
  const router = useRouter();
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 模型当前所在文件夹取 gguf_file 的目录段（与 namespace 无关，两者是两件事）
  const currentFolder = model.ggufFile.split("/")[0];
  const candidates = folders.filter((f) => f !== currentFolder);

  async function onConfirm() {
    if (target === null || busy) return;
    setBusy(true);
    setError(null);
    const res = await apiFetch(`/api/v1/models/${model.name}/move-files`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toFolder: target }),
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
    if (res.status === 423) setError(t("errorLocked"));
    else if (res.status === 409) setError(t("errorRunning"));
    else if (res.status === 404) setError(t("errorNotFound"));
    else if (res.status === 400) setError(t("errorBadRequest"));
    else setError(t("errorRequest"));
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description", { model: model.displayName })}</DialogDescription>
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
                {candidates.map((f) => (
                  <SelectItem key={f} value={f}>
                    {f}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

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
  folders,
  runningName,
}: {
  model: ModelView;
  namespaces: string[];
  /** 磁盘全部一级目录（⋯ 菜单「移动文件到…」候选） */
  folders: string[];
  /** 当前运行的其他模型名：非空时本行 Start 语义为「切换」（服务端原子 stop+start） */
  runningName: string | null;
}) {
  const t = useTranslations("pages.models");
  const router = useRouter();
  const [pending, setPending] = useState<"start" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moveNamespaceOpen, setMoveNamespaceOpen] = useState(false);
  const [moveFilesOpen, setMoveFilesOpen] = useState(false);
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
      <TableCell className="w-[112px]">
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
      <TableCell className="w-[92px]">
        {model.quant ? (
          <Badge variant="outline" className="font-mono text-xs">
            {model.quant}
          </Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="w-[110px] font-mono text-[13px] tabular-nums">
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
      <TableCell className="font-mono text-[13px] tabular-nums">:{model.hostPort}</TableCell>
      <TableCell>
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
            {/* ⋯ 菜单（T12 起 + 模板克隆；阶段 1b B6 拆分）：另存为新模板不受
                运行状态限制（规格 §6.2，克隆只建配置行不碰容器/磁盘）；「改
                命名空间」「移动文件到…」都会被服务端拒绝运行中操作，入口
                统一禁用，避免多绕一次请求才发现被拒 */}
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
                  title={model.status === "running" ? t("moveLockedRunning") : undefined}
                  onClick={() => setMoveNamespaceOpen(true)}
                >
                  <Tag />
                  {t("actionMoveNamespace")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={model.status === "running"}
                  title={model.status === "running" ? t("moveLockedRunning") : undefined}
                  onClick={() => setMoveFilesOpen(true)}
                >
                  <FolderInput />
                  {t("actionMoveFiles")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {error && <p className="text-xs whitespace-normal text-destructive">{error}</p>}
        </div>
        <MoveNamespaceDialog
          model={model}
          namespaces={namespaces}
          open={moveNamespaceOpen}
          onOpenChange={setMoveNamespaceOpen}
        />
        <MoveFilesDialog
          model={model}
          folders={folders}
          open={moveFilesOpen}
          onOpenChange={setMoveFilesOpen}
        />
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

export interface ModelsTableProps {
  /** 当前切片（page 已按选中命名空间过滤好，选中「全部模型」时即全量） */
  models: ModelView[];
  /** 全部命名空间（⋯ 菜单「改命名空间」候选，与当前查看哪个空间无关，故整份传入） */
  namespaces: string[];
  /** 磁盘全部一级目录（⋯ 菜单「移动文件到…」候选，阶段 1b B6 新增——与
   * namespaces 是两份完全独立的候选列表，彼此不再有对应关系） */
  folders: string[];
  /** 当前运行模型名（切换语义用）：必须来自全量模型而非本表的切片——用户切到
   * 别的命名空间查看时，「启动会顶掉谁」这条判断不能因为看的空间变了而失真 */
  runningName: string | null;
  /** 选中「全部模型」时为 true：按命名空间插入分组头行；选中具体空间时为
   * false，单表不分组（这一维已经交给左侧二级栏切片，组内再分是冗余） */
  groupByNamespace: boolean;
}

/** 一张表 + 上方工具条：状态筛选 chip + 搜索 + 常驻新建入口（M16 T5）。
 * 选中「全部模型」时按命名空间插分组头行，保留「模型属于哪个空间」的可见性；
 * 选中具体空间时是纯平的一张表。底部附单模型约束说明。 */
export function ModelsTable({ models, namespaces, folders, runningName, groupByNamespace }: ModelsTableProps) {
  const t = useTranslations("pages.models");
  const [activeChip, setActiveChip] = useState("all");
  const [search, setSearch] = useState("");

  const keyword = search.trim().toLowerCase();
  const searchMatch = (m: ModelView) =>
    keyword === "" ||
    m.displayName.toLowerCase().includes(keyword) ||
    m.name.toLowerCase().includes(keyword);

  // 全部 chip 恒真，其余四个直接复用 StatusBadge 同款文案（statusRunning 等
  // 已经是这四态各自的展示名，没必要再起一套近乎重复的 chip 专属文案）
  const chipDefs: { key: string; label: string; match: (m: ModelView) => boolean }[] = [
    { key: "all", label: t("chipAll"), match: () => true },
    { key: "running", label: t("statusRunning"), match: (m) => m.status === "running" },
    { key: "ready", label: t("statusReady"), match: (m) => m.status === "ready" },
    { key: "missing-file", label: t("statusMissingFile"), match: (m) => m.status === "missing-file" },
    {
      key: "missing-mmproj",
      label: t("statusMissingMmproj"),
      match: (m) => m.status === "missing-mmproj",
    },
  ];

  // 计数必须喂当前切片的全量模型（经搜索收窄），不能喂已按 chip 过滤后的
  // 可见列表——否则除当前选中项外全部归零，把用户点回其它筛选的路焊死
  const counts = computeChipCounts(models, chipDefs, searchMatch);
  const activeMatch = chipDefs.find((c) => c.key === activeChip)?.match ?? (() => true);
  const visible = models.filter((m) => searchMatch(m) && activeMatch(m));

  // 分组：按命名空间名排序；组内保持 visible 的原序（即 listModels 的 name 序）
  const rows: { namespace: string; items: ModelView[] }[] = groupByNamespace
    ? Array.from(
        visible.reduce((byNs, m) => {
          const bucket = byNs.get(m.namespace);
          if (bucket) bucket.push(m);
          else byNs.set(m.namespace, [m]);
          return byNs;
        }, new Map<string, ModelView[]>()),
      )
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([namespace, items]) => ({ namespace, items }))
    : [{ namespace: "", items: visible }];

  return (
    <div className="flex flex-col">
      <Toolbar
        chips={chipDefs.map((c) => ({ key: c.key, label: c.label, count: counts[c.key] }))}
        activeChip={activeChip}
        onChipChange={setActiveChip}
        // 分母取「全部」chip 的计数（counts.all），不是切片全量：两个数字
        // 挤在同一条工具条里，搜索一激活就会变成「全部 3」旁边写着「/ 10」
        // 两个数打架——有 chip 时分母必须跟"全部"这枚 chip 保持同一个值
        // （对齐设计稿 page-models.html 的 tbNote 用 counts.all；M16 T6
        // 复核时发现的 T5 遗留问题，一并修）
        note={{ shown: visible.length, total: counts.all }}
        search={{ value: search, onChange: setSearch, placeholder: t("searchPlaceholder") }}
        // 常驻新建入口（补的真实缺口）：全站三个 /models/new 入口原先全在空态与
        // 引导里，模型一多空态不再出现，用户就再也摸不到新建向导
        action={
          <Button size="sm" nativeButton={false} render={<Link href="/models/new" />}>
            <Plus className="size-3.5" />
            {t("newModel")}
          </Button>
        }
      />

      <div className="px-7 py-5">
        <Table className="min-w-[860px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[112px]">{t("colStatus")}</TableHead>
              <TableHead>{t("colModel")}</TableHead>
              <TableHead className="w-[92px]">{t("colQuant")}</TableHead>
              <TableHead className="w-[110px]">{t("colSize")}</TableHead>
              <TableHead>{t("colPort")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((group) => (
              <Fragment key={group.namespace || "__flat__"}>
                {groupByNamespace && (
                  <TableRow className="bg-muted/30 hover:bg-muted/30">
                    <TableCell colSpan={6} className="py-2">
                      <span className="font-mono text-[12.5px] font-semibold">{group.namespace}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {formatSize(group.items.reduce((sum, m) => sum + m.sizeBytes, 0))}
                      </span>
                    </TableCell>
                  </TableRow>
                )}
                {group.items.map((model) => (
                  <ModelRow
                    key={model.name}
                    model={model}
                    namespaces={namespaces}
                    folders={folders}
                    runningName={runningName}
                  />
                ))}
              </Fragment>
            ))}
            {visible.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="py-8 text-center text-xs text-muted-foreground">
                  {/* 切片本身为空与"筛掉了"是两回事：前者该去新建/移入模型，
                      后者该放宽筛选，同一句话指不了两个方向 */}
                  {models.length === 0 ? t("nsEmpty") : t("noMatch")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <p className="-mt-2 px-7 pb-6 text-xs text-muted-foreground">{t("footnote")}</p>
    </div>
  );
}
