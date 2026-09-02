"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Archive,
  Check,
  Circle,
  CircleDashed,
  Download,
  FilePlus2,
  FolderSymlink,
  FolderX,
  Layers,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";

import { BatchCreateDialog } from "@/components/models/batch-create-form";
import { PageHeader } from "@/components/shell/page-header";
import { SecondaryNav } from "@/components/shell/secondary-nav";
import { toast } from "@/components/toast-store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { apiFetch } from "@/lib/api";
import { formatSize } from "@/lib/format";
import { buildModelsTabItems } from "@/lib/models-tabs";
import { localOnlyRows, mergeRepoRows, summarizeRepoRows, type RepoRow } from "@/lib/repo-files-view";
import { buildRepoViewItems, resolveRepoView } from "@/lib/repo-readme-tabs";
import { cn } from "@/lib/utils";
import { DeleteDialog, MoveDialog } from "./repo-dialogs";
import { ReadmeView } from "./readme-view";

/** 与 server/repoProfiles.ts 的 RepoProfile 一致（page.tsx 直接透传，未经 HTTP） */
export interface RepoProfileSummary {
  id: number;
  repo: string;
  baseDir: string;
  targetDir: string;
  createdAt: number;
}

interface RemoteFile {
  path: string;
  size: number;
  oid?: string;
}

interface RemoteGroup {
  quant: string | null;
  label: string;
  kind: "model" | "mmproj";
  files: RemoteFile[];
  totalSize: number;
  shards: number;
  shardTotalDeclared: number | null;
}

/** 与 GET /api/v1/repos/:id/files 响应逐字段对齐（该路由 JSDoc 写了完整形状，
 *  见 src/app/api/v1/repos/[id]/files/route.ts） */
interface RepoFilesResponse {
  id: number;
  repo: string;
  baseDir: string;
  targetDir: string;
  createdAt: number;
  dirExists: boolean;
  remote: { ok: true; groups: RemoteGroup[] } | { ok: false; message: string };
  local: { rel: string; size: number }[];
  strays: { file: string; rel: string; size: number }[];
  tasks: { file: string; status: string; downloadedBytes: number }[];
  configs: { rel: string; models: string[] }[];
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** HF LFS oid（内容 sha256）转下载文件条目；非 LFS（无 oid）省略校验字段——
 *  `toDownloadFile` 现在是全库唯一一份（wizard.tsx 的同名助手已随本里程碑
 *  一起删掉）。`SHA256_PATTERN` 的正则本身仍有三处：本文件、
 *  api/v1/repos/[id]/download/route.ts 各自一份同名常量，外加
 *  core/schemas.ts 里未导出的 sha256Schema（服务 ModelConfig.download 字段
 *  校验，语义不同、不能直接复用）——三处都只有一行正则，抽公共模块换来的
 *  是一次多余的 import，暂不做（YAGNI，不是遗漏）*/
function toDownloadFile(f: RemoteFile): { file: string; size: number; sha256?: string } {
  return {
    file: f.path,
    size: f.size,
    ...(f.oid !== undefined && SHA256_PATTERN.test(f.oid) ? { sha256: f.oid } : {}),
  };
}

/** 可勾选下载的状态：已下载/下载中的行没什么好下的；在别处（stray）的行
 *  应该点「归位」而不是再下一份重复文件到档案目录——见任务 9 报告的取舍 */
function isSelectable(row: RepoRow): boolean {
  return row.state === "absent" || row.state === "partial";
}

/**
 * 档案详情页内容（任务 9）：page.tsx 只给了 `profile`（DB 单行，同步可得），
 * 量化清单要打 HF，本组件挂载后才 fetch `GET /api/v1/repos/:id/files`，
 * 期间显示加载态，失败给可重试的错误块（任务 9 补充裁定 1）。
 *
 * 远端不可达（`remote.ok === false`，国内网络下的常态）不算异常分支：顶部
 * 警示条 + 退化用 `local` 渲染行（`localOnlyRows`），用户仍能看到已下载的
 * 文件、仍能建配置，只是暂时看不到还有哪些量化可下——不许白屏（裁定 2）。
 */
export function RepoDetailView({
  profile,
  landingReadme,
}: {
  profile: RepoProfileSummary;
  landingReadme: boolean;
}) {
  const t = useTranslations("pages.repos");
  const tModels = useTranslations("pages.models");
  const router = useRouter();

  const [data, setData] = useState<RepoFilesResponse | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "error">("loading");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [repairBusy, setRepairBusy] = useState(false);
  const [repositioningRel, setRepositioningRel] = useState<string | null>(null);

  // 竞态防护：归位/下载选中项/重试/换存放位置成功后都会重新调 fetchDetails，
  // HF 慢的时候前一次请求完全可能还在飞——若不取消，乱序回来的旧响应会把
  // 新数据覆盖掉。每次调用先 abort 掉上一个未完成的请求，只有"最后发起的
  // 那一个"能落地写 state（与 monitoring/run-history.tsx 的 AbortController
  // 用法同一思路，那边是轮询场景，这里是"多个触发点共用同一份请求"场景）
  const fetchControllerRef = useRef<AbortController | null>(null);

  const fetchDetails = useCallback(async () => {
    fetchControllerRef.current?.abort();
    const controller = new AbortController();
    fetchControllerRef.current = controller;
    try {
      const res = await apiFetch(`/api/v1/repos/${profile.id}/files`, {
        signal: controller.signal,
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as RepoFilesResponse;
      setData(body);
      setSelected(new Set());
      setLoadState("loaded");
    } catch (error) {
      // 主动 abort（被下一次调用取代，或组件卸载）不算失败，不能落到错误态
      // 盖掉即将到来的新数据/或者在已经不需要展示的组件上瞎折腾
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        return;
      }
      setLoadState("error");
    }
  }, [profile.id]);

  useEffect(() => {
    // 与 monitoring/run-history.tsx 同一形状：effect 本体不直接调用外部的
    // fetchDetails，而是包一层本地 tick 再调——react-hooks/set-state-in-effect
    // 只沿着 effect 里直接出现的调用表达式做浅层追踪，不会往闭包引用的外部
    // useCallback 函数体里再深挖一层，这层 tick 因此不是凑巧绕过规则，而是
    // 与既有代码同一套写法（该文件卸载时清理走 fetchControllerRef，不需要
    // 再单独建一个 effect 局部的 AbortController）
    const tick = () => void fetchDetails();
    tick();
    return () => fetchControllerRef.current?.abort();
  }, [fetchDetails]);

  const rows: RepoRow[] =
    data === null
      ? []
      : data.remote.ok
        ? mergeRepoRows({
            groups: data.remote.groups,
            local: data.local,
            strays: data.strays,
            tasks: data.tasks,
            configs: data.configs,
            targetDir: data.targetDir,
          })
        : localOnlyRows({ local: data.local, configs: data.configs });

  const summary = data === null ? null : summarizeRepoRows(rows, data.local);
  // M1：接口数据回来之后一律用它的 id/repo/baseDir/targetDir/createdAt——
  // page.tsx 传入的 profile 是服务端组件渲染时的快照，「换存放位置」成功后
  // router.refresh() 与 fetchDetails() 同时触发，后者（DB 查询）先回，此刻
  // profile 这个 prop 还是旧的 baseDir/targetDir。三处用到档案信息的地方
  // （两个弹层 + 归位请求体）都要用同一份新鲜数据，不能各自决定用谁的
  const freshProfile: RepoProfileSummary =
    data === null
      ? profile
      : { id: data.id, repo: data.repo, baseDir: data.baseDir, targetDir: data.targetDir, createdAt: data.createdAt };
  const targetDir = freshProfile.targetDir;
  // 加载完成前不假定目录缺失——首次进入页面时数据还没回来，此时按"缺失"
  // 渲染会让每次打开详情页都先误闪一下"目录缺失"提示区
  const dirExists = data?.dirExists ?? true;
  const occupiedBytes = data === null ? 0 : data.local.reduce((sum, f) => sum + f.size, 0);

  function toggleSelect(index: number, checked: boolean): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(index);
      else next.delete(index);
      return next;
    });
  }

  async function onDownloadSelected(): Promise<void> {
    if (data === null || !data.remote.ok || selected.size === 0 || downloadBusy) return;
    const files = data.remote.groups
      .filter((_, index) => selected.has(index))
      .flatMap((g) => g.files.map(toDownloadFile));
    if (files.length === 0) return;

    setDownloadBusy(true);
    const res = await apiFetch(`/api/v1/repos/${profile.id}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files }),
    }).catch(() => null);
    setDownloadBusy(false);

    if (res === null) {
      toast.error(t("errorNetwork"));
      return;
    }
    if (!res.ok) {
      const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(errBody?.error ?? t("errorRequest"));
      return;
    }
    const okBody = (await res.json().catch(() => null)) as { taskIds: number[] } | null;
    toast.success(t("downloadQueued", { count: okBody?.taskIds.length ?? files.length }));
    await fetchDetails();
  }

  async function onReposition(row: RepoRow): Promise<void> {
    if (row.strayRel === null || repositioningRel !== null) return;
    setRepositioningRel(row.strayRel);
    const res = await apiFetch("/api/v1/files/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: row.strayRel, toFolder: freshProfile.targetDir }),
    }).catch(() => null);
    setRepositioningRel(null);

    if (res === null) {
      toast.error(t("errorNetwork"));
      return;
    }
    if (res.ok) {
      toast.success(t("repositionDone"));
      await fetchDetails();
      return;
    }
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    switch (body?.error) {
      case "LOCKED":
        toast.error(t("repositionErrorLocked"));
        break;
      case "INVALID_PATH":
        toast.error(t("repositionErrorInvalidPath"));
        break;
      case "CONFLICT":
        toast.error(t("repositionErrorConflict"));
        break;
      case "NOT_FOUND":
        toast.error(t("repositionErrorNotFound"));
        break;
      default:
        toast.error(t("errorRequest"));
    }
  }

  async function onRepair(): Promise<void> {
    if (repairBusy) return;
    setRepairBusy(true);
    const res = await apiFetch(`/api/v1/repos/${profile.id}/repair`, { method: "POST" }).catch(() => null);
    setRepairBusy(false);

    if (res === null) {
      toast.error(t("errorNetwork"));
      return;
    }
    if (!res.ok) {
      toast.error(t("repairError"));
      return;
    }
    toast.success(t("repairDone"));
    await fetchDetails();
  }

  // 二级栏顶部两条 tab（任务 9 裁定 7）：详情页 pathname 带 id，仍然落 repos
  // 组，resolveModelsTab 的前缀判定覆盖了这种子路由
  const tabItems = buildModelsTabItems(`/models/repos/${profile.id}`, tModels);
  // 档案详情页的两条视图（README / 文件）与上面两条路由项混排在同一个二级栏里，
  // 各走各的选中判定（HF README 视图）
  const searchParams = useSearchParams();
  const view = resolveRepoView(searchParams.get("view") ?? undefined, landingReadme);
  const viewItems = buildRepoViewItems(view, t);

  return (
    <>
      <SecondaryNav
        kicker="MODELS"
        title={tModels("title")}
        queryKey="view"
        current={view}
        // 两组混排：上面两条是路由项（configs/repos），下面两条是同页视图切换。
        // 路由项显式给 selected —— current 是 view 的值，描述不了它们
        items={[
          ...tabItems.map((item) => ({ ...item, selected: item.key === "repos" })),
          ...viewItems,
        ]}
        groups={[{ beforeKey: "readme", label: profile.repo }]}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader
          icon={Archive}
          title={profile.repo}
          trailing={
            <div className="flex items-center gap-2">
              <MoveDialog
                profile={freshProfile}
                onMoved={() => {
                  router.refresh();
                  void fetchDetails();
                }}
              />
              <DeleteDialog
                profile={freshProfile}
                occupiedBytes={occupiedBytes}
                onDeleted={() => router.push("/models/repos")}
              />
            </div>
          }
        />

        {view === "readme" && (
          <div className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
            <ReadmeView
              repoId={profile.id}
              landingReadme={landingReadme}
              onGoFiles={() => router.replace(`/models/repos/${profile.id}?view=files`)}
            />
          </div>
        )}

        {view === "files" && (
          <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-7 py-5">
            {loadState === "loading" && (
              <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                {t("detailLoading")}
              </div>
            )}

            {loadState === "error" && (
              <Card>
                <CardContent className="flex flex-col items-center justify-center gap-3 py-12 text-center">
                  <TriangleAlert className="size-6 text-destructive" />
                  <p className="text-sm font-medium">{t("detailErrorTitle")}</p>
                  <Button variant="outline" size="sm" onClick={() => void fetchDetails()}>
                    <RefreshCw className="size-3.5" />
                    {t("detailRetry")}
                  </Button>
                </CardContent>
              </Card>
            )}

            {loadState === "loaded" && data !== null && summary !== null && (
              <>
                {!data.remote.ok && (
                  <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-sm text-amber-700 dark:text-amber-400">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                    <div className="flex flex-1 flex-col gap-1.5">
                      <span>{t("remoteUnreachable", { message: data.remote.message })}</span>
                      <div>
                        <Button size="sm" variant="outline" onClick={() => void fetchDetails()}>
                          <RefreshCw className="size-3.5" />
                          {t("detailRetry")}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}

                <p className="font-mono text-xs text-muted-foreground">
                  {t("summaryLine", {
                    targetDir,
                    quantCount: summary.quantCount,
                    downloaded: summary.downloadedCount,
                    size: formatSize(summary.totalBytes),
                  })}
                </p>

                {!dirExists ? (
                  <Card>
                    <CardContent className="flex flex-col items-center justify-center gap-3 py-12 text-center">
                      <span className="flex size-12 items-center justify-center rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400">
                        <FolderX className="size-6" />
                      </span>
                      <p className="text-sm font-medium">{t("dirMissingTitle")}</p>
                      <p className="max-w-md text-sm text-muted-foreground">{t("dirMissingDescription")}</p>
                      <div className="mt-1 flex items-center gap-2">
                        <Button size="sm" disabled={repairBusy} onClick={() => void onRepair()}>
                          {repairBusy ? <Loader2 className="animate-spin" /> : <RefreshCw className="size-3.5" />}
                          {repairBusy ? t("repairing") : t("repairAction")}
                        </Button>
                        <DeleteDialog
                          profile={freshProfile}
                          occupiedBytes={occupiedBytes}
                          onDeleted={() => router.push("/models/repos")}
                        />
                      </div>
                    </CardContent>
                  </Card>
                ) : (
                  <>
                    {rows.length === 0 ? (
                      <p className="py-8 text-center text-xs text-muted-foreground">{t("emptyRows")}</p>
                    ) : (
                      <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(232px,1fr))]">
                        {rows.map((row, index) => (
                          <QuantCard
                            key={`${row.kind}:${row.files.join(",")}`}
                            row={row}
                            index={index}
                            showCheckbox={data.remote.ok}
                            selected={selected.has(index)}
                            onToggleSelect={toggleSelect}
                            dirExists={dirExists}
                            repositioning={row.strayRel !== null && repositioningRel === row.strayRel}
                            onReposition={() => void onReposition(row)}
                          />
                        ))}
                      </div>
                    )}

                    <div className="flex items-center gap-2">
                      {data.remote.ok && (
                        <Button
                          size="sm"
                          disabled={selected.size === 0 || downloadBusy}
                          onClick={() => void onDownloadSelected()}
                        >
                          {downloadBusy ? <Loader2 className="animate-spin" /> : <Download className="size-3.5" />}
                          {downloadBusy ? t("downloadQueueing") : t("downloadSelected")}
                        </Button>
                      )}
                      <BatchCreateDialog repo={profile.repo} rows={rows} onCreated={() => void fetchDetails()} />
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function QuantCard({
  row,
  index,
  showCheckbox,
  selected,
  onToggleSelect,
  dirExists,
  repositioning,
  onReposition,
}: {
  row: RepoRow;
  index: number;
  showCheckbox: boolean;
  selected: boolean;
  onToggleSelect: (index: number, checked: boolean) => void;
  dirExists: boolean;
  repositioning: boolean;
  onReposition: () => void;
}) {
  const t = useTranslations("pages.repos");
  // 降级模式（remote.ok === false）下不渲染勾选框，此时卡片也不该能点选——
  // 选中状态没有下游动作可用（下载按钮同样只在 showCheckbox 时渲染），点了
  // 也是死状态，容易让人以为点了却什么都没发生
  const selectable = showCheckbox && isSelectable(row);
  // RepoRow 没有展示用的 label 字段（复核后已删——上游 core/quant.ts 的
  // "未识别" 是硬编码中文，见 lib/model-file-picker.ts 同一条注释），量化名
  // 一律现算：quant 为 null 时走翻译好的 unknownQuant，不留兜底中文
  const quantLabel = row.quant ?? t("unknownQuant");

  function toggle(): void {
    if (selectable) onToggleSelect(index, !selected);
  }

  // mmproj 是配套的投影文件，不是能独立跑起来的模型，拿它当 gguf_file 建
  // 配置只会得到一份坏配置——lib/batch-create.ts 的 batchCreateCandidates
  // 筛选条件本来就有 kind === "model"，「批量创建配置」那条路早就把 mmproj
  // 排除在外了，这里的单卡按钮是跟那条口径对齐，不是新加的限制
  const createConfigButton =
    row.kind === "model" && row.state === "present" && row.localRels[0] !== undefined ? (
      <Button
        size="sm"
        variant="outline"
        nativeButton={false}
        onClick={(e) => e.stopPropagation()}
        render={<Link href={`/models/new?file=${encodeURIComponent(row.localRels[0])}`} />}
      >
        <FilePlus2 className="size-3.5" />
        {t("actionCreateConfig")}
      </Button>
    ) : null;

  // I6：partial 行也可能带 strayRel（分片组一部分在档案目录内、另一部分
  // 散落别处），条件不能只看 state === "stray"，否则这类行的操作段是空的，
  // 用户既没有归位入口，勾选下载又会重下已到齐的那片
  const repositionButton =
    row.strayRel !== null ? (
      <Button
        size="sm"
        variant="outline"
        disabled={!dirExists || repositioning}
        onClick={(e) => {
          e.stopPropagation();
          onReposition();
        }}
      >
        {repositioning ? <Loader2 className="animate-spin" /> : <FolderSymlink className="size-3.5" />}
        {repositioning ? t("repositioning") : t("actionReposition")}
      </Button>
    ) : null;

  return (
    <div
      role={selectable ? "button" : undefined}
      tabIndex={selectable ? 0 : undefined}
      aria-pressed={selectable ? selected : undefined}
      onClick={selectable ? toggle : undefined}
      onKeyDown={
        selectable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggle();
              }
            }
          : undefined
      }
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3 transition-colors",
        selectable && "cursor-pointer hover:border-foreground/20",
        selected && "border-primary/40 bg-primary/[0.04] ring-1 ring-primary/25",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {showCheckbox && (
          // 勾选框自己就能切换选中，冒泡到卡片会带着 !selected 再切一次——
          // 结果碰巧一致（都是同一次目标状态），但没必要让同一次点击算两次
          <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            <Checkbox
              aria-label={t("selectRow", { name: quantLabel })}
              checked={selected}
              disabled={!selectable}
              onCheckedChange={(checked) => onToggleSelect(index, checked === true)}
            />
          </span>
        )}
        <span className="truncate font-mono text-[13px] font-semibold">{quantLabel}</span>
        {row.kind === "mmproj" && (
          <Badge variant="outline" className="h-4.5 px-1.5 font-sans text-[10px] leading-none text-muted-foreground">
            mmproj
          </Badge>
        )}
        {row.totalShards > 1 && (
          <Badge
            variant="outline"
            className="h-4.5 gap-1 px-1.5 font-sans text-[10px] leading-none text-muted-foreground"
          >
            <Layers className="size-2.5!" />
            {t("shardBadge", { count: row.totalShards })}
          </Badge>
        )}
        <span className="ml-auto font-mono text-xs text-muted-foreground">{formatSize(row.totalSize)}</span>
      </div>

      <StateCell row={row} />

      {(createConfigButton !== null || repositionButton !== null) && (
        <div className="flex items-center gap-2 pt-0.5">
          {createConfigButton}
          {repositionButton}
        </div>
      )}
    </div>
  );
}

/** 状态列渲染（设计 §9.3 状态表）：判定已经在 mergeRepoRows/localOnlyRows
 *  里做完，这里只管把 state 映射成图标 + 文案 */
function StateCell({ row }: { row: RepoRow }) {
  const t = useTranslations("pages.repos");
  switch (row.state) {
    case "downloading":
      return (
        <span className="flex items-center gap-1.5 text-sm text-primary">
          <Loader2 className="size-3.5 animate-spin" />
          {t("stateDownloading", { percent: Math.round((row.progress ?? 0) * 100) })}
        </span>
      );
    case "present":
      return (
        <span className="flex items-center gap-1.5 text-sm text-accent-green">
          <Check className="size-3.5" />
          {t("statePresent")}
          {row.models.length > 0 && (
            <Badge
              variant="outline"
              className="h-4.5 px-1.5 font-sans text-[10px] leading-none text-muted-foreground"
            >
              {t("modelsRefCount", { count: row.models.length })}
            </Badge>
          )}
        </span>
      );
    case "partial":
      return (
        <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <CircleDashed className="size-3.5" />
          {t("statePartial", { have: row.haveShards, total: row.totalShards })}
        </span>
      );
    case "stray":
      return (
        <span className="flex min-w-0 flex-col gap-0.5 text-sm text-amber-600 dark:text-amber-400">
          <span className="flex items-center gap-1.5">
            <TriangleAlert className="size-3.5" />
            {t("stateStray")}
          </span>
          {row.strayRel !== null && (
            // 卡片网格比表格窄得多，长路径在这里必超宽——截断 + title 悬停看全路径
            <span className="truncate font-mono text-[11px] text-muted-foreground" title={row.strayRel}>
              {t("strayAt", { dir: row.strayRel })}
            </span>
          )}
        </span>
      );
    default:
      // 「未下载」是空状态提示，不是内容——用比 muted-foreground 更淡的
      // muted-subtle，避免用户把它看成已经填了点什么
      return (
        <span className="flex items-center gap-1.5 text-sm text-muted-subtle">
          <Circle className="size-3.5" />
          {t("stateAbsent")}
        </span>
      );
  }
}

