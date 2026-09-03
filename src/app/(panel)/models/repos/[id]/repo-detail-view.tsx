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

import { shardGroup } from "@/core/files";
import type { ServerConfig } from "@/core/schemas";
import { BatchCreateDialog } from "@/components/models/batch-create-form";
import { PageHeader } from "@/components/shell/page-header";
import { SecondaryNav } from "@/components/shell/secondary-nav";
import { toast } from "@/components/toast-store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { apiFetch } from "@/lib/api";
import { formatSize } from "@/lib/format";
import { buildModelsTabItems } from "@/lib/models-tabs";
import type { RecommendedProfile } from "@/lib/readme-params";
import {
  isSelectable,
  localOnlyRows,
  mergeRepoRows,
  retainedSelection,
  sameQuantIdentity,
  summarizeRepoRows,
  type RepoRow,
} from "@/lib/repo-files-view";
import { buildRepoViewItems, resolveRepoView } from "@/lib/repo-readme-tabs";
import { repoWeightItems } from "@/lib/repo-weights";
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
  remote:
    | { ok: true; groups: RemoteGroup[]; fetchedAt: number; stale: boolean; error: string | null }
    | { ok: false; message: string };
  local: { rel: string; size: number }[];
  strays: { file: string; rel: string; size: number }[];
  tasks: { file: string; status: string; downloadedBytes: number }[];
  configs: { rel: string; models: string[] }[];
}

/** `RepoFilesResponse` → 渲染用的 rows。渲染期用它得出 `rows`，`fetchDetails`
 *  落地新响应时也要用同一套派生算出 `nextRows` 交给 `retainedSelection` 剪枝
 *  ——两处必须共用同一份逻辑，否则"清单身份判定"和"按新行剪枝选中"用的是
 *  两份可能不一致的口径，剪枝结果就不可信了 */
function deriveRows(body: RepoFilesResponse | null): RepoRow[] {
  if (body === null) return [];
  return body.remote.ok
    ? mergeRepoRows({
        groups: body.remote.groups,
        local: body.local,
        strays: body.strays,
        tasks: body.tasks,
        configs: body.configs,
        targetDir: body.targetDir,
      })
    : localOnlyRows({ local: body.local, configs: body.configs });
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
  effective,
}: {
  profile: RepoProfileSummary;
  landingReadme: boolean;
  /** 全局默认 server 配置（SSR 取好传下来），README 推荐卡拿它当 diff 基准 */
  effective: ServerConfig;
}) {
  const t = useTranslations("pages.repos");
  const tModels = useTranslations("pages.models");
  const router = useRouter();

  const [data, setData] = useState<RepoFilesResponse | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "error">("loading");
  // 远端量化清单的刷新态（手动点按钮 / 过期后自动后台重取共用同一个状态）：
  // 与整页的 loadState 分开，是因为后台重取不该整页转圈——首屏已经用旧数据
  // 渲染好了，这里只驱动按钮的 spinner 与清单顶部那行轻量提示
  const [remoteRefreshing, setRemoteRefreshing] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [repairBusy, setRepairBusy] = useState(false);
  const [repositioningRel, setRepositioningRel] = useState<string | null>(null);
  // 用户在推荐卡上点了「应用到建配置」后勾选到的字段集合：T18 先只存，T19 的
  // BatchCreateDialog 才读它决定预选哪一套（见 URL 上的 applyRecommend=<profileId>）。
  // router.replace 只改 query、组件不重挂载，这份内存 state 在同一次会话里存活；
  // 硬刷新后丢失会退化成「从下拉现选该 profile」，那正是 T19 的默认口径
  const [appliedRecommend, setAppliedRecommend] = useState<{
    profileId: string;
    server: Partial<ServerConfig>;
  } | null>(null);
  // README 视图 fetch 成功后上报的推荐参数集：BatchCreateDialog「本仓库推荐」
  // 下拉组要用。切到文件视图后 ReadmeView 卸载，这份数据不会再更新——
  // 硬刷新直接落在文件视图时它是空数组，这是刻意的边界（见 readme-view.tsx 的说明）
  const [readmeProfiles, setReadmeProfiles] = useState<RecommendedProfile[]>([]);

  // 竞态防护：归位/下载选中项/重试/换存放位置成功后都会重新调 fetchDetails，
  // HF 慢的时候前一次请求完全可能还在飞——若不取消，乱序回来的旧响应会把
  // 新数据覆盖掉。每次调用先 abort 掉上一个未完成的请求，只有"最后发起的
  // 那一个"能落地写 state（与 monitoring/run-history.tsx 的 AbortController
  // 用法同一思路，那边是轮询场景，这里是"多个触发点共用同一份请求"场景）
  const fetchControllerRef = useRef<AbortController | null>(null);
  // stale-while-revalidate 的自动后台重取只在每次挂载（或 profile.id 换挡）
  // 后打一次，不然刷新失败（响应仍 remote.stale: true）会变成每次拿到数据
  // 都再打一次 HF 的无限循环——见下方 useEffect 里的复位
  const autoRefreshedRef = useRef(false);
  // 上一次拿到的远端分组（只留 sameQuantIdentity 要比对的两个字段），供
  // fetchDetails 判断这次拿回来的是不是同一份清单——不能把 data 加进
  // fetchDetails 的 useCallback 依赖来读旧值：那会让这个回调随每次数据变化
  // 而重建，进而让依赖它的 effect 反复重跑，还可能撞上开发时已经踩过的
  // react-hooks/refs、react-hooks/set-state-in-effect 那两条规则；用 ref 存、
  // 在 setData 的同一处更新，读写都在事件/回调里，不在渲染期
  const lastGroupsRef = useRef<{ quant: string | null; kind: string }[] | null>(null);

  const fetchDetails = useCallback(
    async (refresh = false) => {
      fetchControllerRef.current?.abort();
      const controller = new AbortController();
      fetchControllerRef.current = controller;
      try {
        const res = await apiFetch(`/api/v1/repos/${profile.id}/files${refresh ? "?refresh=1" : ""}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as RepoFilesResponse;
        const newGroups = body.remote.ok ? body.remote.groups : null;
        // selected 存的是 rows 下标，清单一变下标就会指向别的档，不能无脑
        // 保留；但 stale-while-revalidate 的后台重取绝大多数拿回来的是同一份
        // 清单（TTL 到期不代表作者真的传了新文件），这种情况下整体清空选中
        // 纯属误伤——复现过的真实缺陷：用户在后台重取还没回来的几秒内点了
        // 权重卡跳到文件视图并勾中一项，重取一回来选中就被冲掉了。首次加载
        // （lastGroupsRef 还是 null）按"身份不同"处理，此时本来也没有选中，
        // 清不清都一样
        const sameIdentity =
          lastGroupsRef.current !== null && newGroups !== null && sameQuantIdentity(lastGroupsRef.current, newGroups);
        // 但清单身份没变也不能无脑整体保留：fetchDetails 同时被下载/归位/
        // 修复/批量建配置的成功路径复用，这些动作不改变远端清单本身（身份
        // 判定仍是"同一份"），却会把某一行的状态从 absent 变成
        // downloading——那一行在新一轮 rows 里已经不可选，若还留在
        // selected 里，"下载选中项"按钮只看 selected.size、不看是否仍可选，
        // 会照样可点，再点一次就把同一个文件重新入队下载。用 retainedSelection
        // 按 nextRows 逐个下标剪枝，只留仍然可选的；nextRows 与下面渲染期的
        // rows 必须是同一套派生（deriveRows），否则剪枝对不上真实渲染出来的
        // 下标含义。用 setSelected 的函数式更新读最新的 selected，不把
        // selected 加进本回调的依赖数组（同上面 lastGroupsRef 那条注释的理由：
        // 避免 fetchDetails 随 state 变化反复重建）
        const nextRows = deriveRows(body);
        setData(body);
        setSelected((prev) => retainedSelection(prev, nextRows, sameIdentity));
        lastGroupsRef.current = newGroups;
        setLoadState("loaded");
      } catch (error) {
        // 主动 abort（被下一次调用取代，或组件卸载）不算失败，不能落到错误态
        // 盖掉即将到来的新数据/或者在已经不需要展示的组件上瞎折腾
        if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
          return;
        }
        setLoadState("error");
      }
    },
    [profile.id],
  );

  useEffect(() => {
    // 与 monitoring/run-history.tsx 同一形状：effect 本体不直接调用外部的
    // fetchDetails，而是包一层本地 tick 再调——react-hooks/set-state-in-effect
    // 只沿着 effect 里直接出现的调用表达式做浅层追踪，不会往闭包引用的外部
    // useCallback 函数体里再深挖一层，这层 tick 因此不是凑巧绕过规则，而是
    // 与既有代码同一套写法（该文件卸载时清理走 fetchControllerRef，不需要
    // 再单独建一个 effect 局部的 AbortController）
    autoRefreshedRef.current = false;
    const tick = () => void fetchDetails();
    tick();
    return () => fetchControllerRef.current?.abort();
  }, [fetchDetails]);

  // stale-while-revalidate 的「revalidate」那一半：数据落地后若远端清单已
  // 过期，自动补一次带 ?refresh=1 的后台重取——单独一个 effect 而不是在
  // fetchDetails 内部递归调用自己，是刻意避开 useCallback 自引用（会被
  // react-hooks/immutability 判为「用到了还没声明完的自身」）。guard 在真正
  // 决定要发第二次请求之前就置位，即使这次自动重取本身失败（getRemoteGroups
  // 回落旧缓存，响应依旧 stale: true）也不会在同一次挂载里反复触发
  useEffect(() => {
    if (data !== null && data.remote.ok && data.remote.stale && !autoRefreshedRef.current) {
      autoRefreshedRef.current = true;
      setRemoteRefreshing(true);
      void fetchDetails(true).finally(() => setRemoteRefreshing(false));
    }
  }, [data, fetchDetails]);

  async function onManualRemoteRefresh(): Promise<void> {
    if (remoteRefreshing) return;
    // 用户已经手动做过一次「revalidate」了，这次挂载不再需要自动后台重取
    // 那一份——即使这次手动刷新本身失败（回落旧缓存，stale 仍是 true），也
    // 不该在用户眼皮底下紧接着再自己打一次
    autoRefreshedRef.current = true;
    setRemoteRefreshing(true);
    await fetchDetails(true);
    setRemoteRefreshing(false);
  }

  const rows: RepoRow[] = deriveRows(data);

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
              effective={effective}
              landingReadme={landingReadme}
              weights={repoWeightItems(rows)}
              weightsLoading={loadState === "loading"}
              onGoFiles={() => router.replace(`/models/repos/${profile.id}?view=files`)}
              onApplyRecommend={(profileId, server) => {
                setAppliedRecommend({ profileId, server });
                router.replace(`/models/repos/${profile.id}?view=files&applyRecommend=${profileId}`);
              }}
              onProfilesLoaded={setReadmeProfiles}
              onPickWeight={(index) => {
                const row = rows[index];
                // 只有可选中下载的档才顺带勾选——已下载完成/下载中/在别处的档
                // 在文件视图里勾选框本来就是禁用的，硬勾会造出一个自相矛盾的状态
                if (row !== undefined && isSelectable(row)) setSelected(new Set([index]));
                router.replace(`/models/repos/${profile.id}?view=files`);
              }}
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

                {data.remote.ok && (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {remoteRefreshing ? (
                      <span className="flex items-center gap-1.5">
                        <Loader2 className="size-3 animate-spin" />
                        {t("remoteRefreshing")}
                      </span>
                    ) : (
                      <>
                        {data.remote.stale && (
                          <span>{t("remoteCachedAt", { time: new Date(data.remote.fetchedAt).toLocaleString() })}</span>
                        )}
                        {data.remote.error !== null && <span>{t("remoteRefreshFailed")}</span>}
                      </>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      className="ml-auto"
                      disabled={remoteRefreshing}
                      onClick={() => void onManualRemoteRefresh()}
                    >
                      {remoteRefreshing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                      {t("readmeRefresh")}
                    </Button>
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
                      <BatchCreateDialog
                        repo={profile.repo}
                        rows={rows}
                        profiles={readmeProfiles}
                        effective={effective}
                        initialProfileId={searchParams.get("applyRecommend") ?? undefined}
                        initialServer={appliedRecommend?.server}
                        onCreated={() => void fetchDetails()}
                      />
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
  // 主身份用**完整文件名**而不是量化标签：量化是从文件名启发式认出来的，
  // 认错或认不出时（各家命名并不都守规矩）标签就成了假身份，用户无从分辨
  // 两个不同的档——真机 unsloth 的 UD-Q6_K_XL 一度被截断成 Q6_K，与同仓库
  // 真的 Q6_K 在界面上完全同名。文件名是硬事实，量化降为旁边的 tag。
  // 分片组剥掉 -0000N-of-0000M 只留共同前缀：整组本来就是一个下载单元，
  // 列出其中某一片的序号会让人以为只下这一片（片数由旁边的 ×N 徽章表达）
  const primary = fileLabel(row);

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
      {/* 文件名一行、徽章与大小另起一行：文件名成为主身份后可以长到
          `Qwen3.8-27B-UD-Q4_K_XL` 这个量级，与徽章挤在同一行会把徽章顶到
          换行、或把文件名截得只剩前半段。line-clamp-2 给它两行的余量，
          再长才省略；完整值仍留在 title 里可悬停查看 */}
      <div className="flex min-w-0 items-start gap-1.5">
        {showCheckbox && (
          // 勾选框自己就能切换选中，冒泡到卡片会带着 !selected 再切一次——
          // 结果碰巧一致（都是同一次目标状态），但没必要让同一次点击算两次
          <span
            className="mt-0.5 shrink-0"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <Checkbox
              aria-label={t("selectRow", { name: primary })}
              checked={selected}
              disabled={!selectable}
              onCheckedChange={(checked) => onToggleSelect(index, checked === true)}
            />
          </span>
        )}
        {/* 悬停看完整名走 Tooltip 原语而不是原生 title：原生的延迟长、样式不可控，
            也不响应键盘 focus。tabIndex 让键盘用户同样够得着 */}
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                tabIndex={0}
                className="line-clamp-2 min-w-0 cursor-default font-mono text-[13px] leading-snug font-semibold break-words outline-none focus-visible:underline"
              />
            }
          >
            {primary}
          </TooltipTrigger>
          <TooltipContent className="max-w-sm break-all">{primary}</TooltipContent>
        </Tooltip>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge
          variant="outline"
          className="h-4.5 shrink-0 px-1.5 font-mono text-[10px] leading-none text-muted-foreground"
        >
          {quantLabel}
        </Badge>
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

      {(createConfigButton !== null || repositionButton !== null || row.state === "stray") && (
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          {createConfigButton}
          {repositionButton}
          {row.state === "stray" && <StrayMark row={row} />}
        </div>
      )}
    </div>
  );
}

/**
 * 一行的展示名：分片组取剥掉 `-0000N-of-0000M` 后的共同前缀，单文件取原路径。
 * 保留子目录（`BF16/…`）——同一仓库不同目录下的同名档靠它区分。
 */
function fileLabel(row: RepoRow): string {
  const first = row.files[0];
  if (first === undefined) return "";
  return shardGroup(first)?.prefix ?? first;
}

/**
 * 「在别处」的警告标记：只占一个感叹号，「在别处」与所在路径都收进气泡。
 * 原先它是状态列里的两行（第二行是完整路径），在卡片网格的窄列里必然超宽，
 * 是整张卡最吵的一块。放在「归位」按钮右边——问题与处理方式挨在一起。
 */
function StrayMark({ row }: { row: RepoRow }) {
  const t = useTranslations("pages.repos");
  const detail =
    row.strayRel === null
      ? t("stateStray")
      : `${t("stateStray")} · ${t("strayAt", { dir: row.strayRel })}`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={detail}
            // 卡片整体可点选，这个按钮的点击不该连带切换选中状态
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-amber-600 transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring dark:text-amber-400"
          />
        }
      >
        <TriangleAlert className="size-4" />
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <span className="font-medium">{t("stateStray")}</span>
        {row.strayRel !== null && (
          <span className="mt-0.5 block font-mono break-all">
            {t("strayAt", { dir: row.strayRel })}
          </span>
        )}
      </TooltipContent>
    </Tooltip>
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
      // 不在这里渲染：stray 行必有「归位」按钮（strayRel 非空即渲染），
      // 把警告收到那一行的按钮右边，省掉一整行、也让「出了什么事」与
      // 「怎么处理」挨在一起。见下方 StrayMark 与操作段
      return null;
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

