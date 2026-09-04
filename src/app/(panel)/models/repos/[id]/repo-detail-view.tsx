"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Archive,
  Check,
  ChevronDown,
  ChevronUp,
  Circle,
  CircleDashed,
  CircleHelp,
  Download,
  FilePlus2,
  FolderInput,
  FolderSymlink,
  FolderX,
  Layers,
  Link2,
  Loader2,
  RefreshCw,
  ScanSearch,
  TriangleAlert,
} from "lucide-react";

import { shardGroup, shardInfo } from "@/core/files";
import type { PathMap } from "@/core/paths";
import type { ServerConfig } from "@/core/schemas";
import { BatchCreateDialog } from "@/components/models/batch-create-form";
import { ModelFilePicker } from "@/components/models/model-file-picker";
import { PageHeader } from "@/components/shell/page-header";
import { SecondaryNav } from "@/components/shell/secondary-nav";
import { toast } from "@/components/toast-store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ACTION_ORDER, type AcquireAction, type GroupMatch, type LocalCandidate } from "@/lib/acquire-match";
import {
  applyTaskUpdate,
  buildAcquireSubmitItems,
  buildRows,
  groupKey,
  hasExecutingRow,
  matchScannedGroups,
  type AcquireRow,
} from "@/lib/acquire-plan";
import { apiFetch } from "@/lib/api";
import { formatSize } from "@/lib/format";
import { buildPickerItems, type PickerFile, type PickerItem } from "@/lib/model-file-picker";
import { buildModelsTabItems } from "@/lib/models-tabs";
import type { RecommendedProfile } from "@/lib/readme-params";
import {
  buildGroupingRows,
  groupRowsByDir,
  hasSubdirs,
  isSelectable,
  localOnlyRows,
  matchedRemoteGroup,
  mergeRepoRows,
  retainedSelection,
  sameGroupIdentity,
  summarizeRepoRows,
  type RepoDirGroup,
  type RepoRow,
} from "@/lib/repo-files-view";
import { buildRepoViewItems, resolveRepoView } from "@/lib/repo-readme-tabs";
import { repoWeightItems } from "@/lib/repo-weights";
import { repoWeightsViewStore, type RepoWeightsView } from "@/lib/repo-weights-view";
import { parseScanExtraDirs } from "@/lib/scan-extra-dirs";
import { subscribeStream } from "@/lib/shared-event-source";
import { cn } from "@/lib/utils";
import type { DriftState } from "@/lib/version-drift";
import { AcquireDialog } from "./acquire-dialog";
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
  /** sharedWith：全盘与该文件同 inode（硬链接）的其他路径，任务 15 起随
   *  `GET /files` 补上，供 QuantCard 渲染共用标注（设计 §9.1）。drift 是本地
   *  这份与远端当前版本的关系，远端不可达时字段整个不出现（见路由头注释） */
  local: { rel: string; size: number; sharedWith: string[]; drift?: DriftState }[];
  strays: { file: string; rel: string; size: number; inRepoDir: string | null; drift?: DriftState }[];
  tasks: { file: string; status: string; downloadedBytes: number }[];
  configs: { rel: string; models: string[] }[];
  /** 当前运行中模型引用的文件（models 根相对路径，任务 15）：「更新到最新版」
   *  按钮靠它判定要不要禁用 */
  lockedRels: string[];
}

/** POST /repos/:id/scan 的响应（任务 12 已定形状，这里对齐消费）。
 *  `unarchived` 是手动关联弹层的候选池（任务 16，规格 §7.2）：models 内全部
 *  未归档文件，服务端早就返回了（scan/route.ts:147），前端类型此前没跟上 */
interface ScanResult {
  groups: GroupMatch[];
  unreachable: string[];
  // 复核修复 K-9：服务端 scan/route.ts 下发的其实是 getDiscoveredMounts()
  // 的 PathMap[]（{host, panel}），此前声明成 string[]——渲染处把整个对象
  // 塞进模板字符串/join，界面上会看到 "[object Object]"
  availableMounts: PathMap[];
  unarchived: LocalCandidate[];
}

/** downloads SSE "tasks" 帧里单条任务的结构性子集——只取 applyTaskUpdate
 *  折算进度用得到的字段，不把 downloads-view.tsx 的 DownloadTaskEntry
 *  整个类型搬过来 */
interface AcquireTaskSnapshot {
  batchId: string;
  file: string;
  status: string;
  downloadedBytes: number;
  expectedSize: number | null;
  error: string | null;
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

/** basename：远端路径固定用 "/"，与 lib/acquire-match.ts 的同名函数同一份
 *  逻辑——本文件是 client 组件用不了 node:path，量小不值得为它新增一个
 *  共享 lib 文件，就地实现（任务 15 复核 F-1，onConfirmUpdate 用它核对
 *  远端组与本地行是不是同一组） */
function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/** 一行的组身份：kind + 全部文件名唯一确定一组（分片组内文件名各不相同）。
 *  用作 QuantCard 的 React key，也用作「哪一行正在归位」的标识——row 本身
 *  不带下标以外的稳定 id，rows 数组的下标又会在 stale-while-revalidate 的
 *  重取后失效，这份组合胜在两处场景都用同一份口径，不必分别维护 */
function rowKey(row: RepoRow): string {
  return `${row.kind}:${row.files.join(",")}`;
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
  scanExtraDirs,
}: {
  profile: RepoProfileSummary;
  landingReadme: boolean;
  /** 全局默认 server 配置（SSR 取好传下来），README 推荐卡拿它当 diff 基准 */
  effective: ServerConfig;
  /** 已持久化的自定义扫描目录（宿主机视角，SSR 取好传下来）：回填输入框，
   *  让用户看得见当前生效的扫描范围，也才有办法把它改回去 */
  scanExtraDirs: readonly string[];
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
  // 任务 11 起用组身份（`${kind}:${files.join(",")}`，与 QuantCard 的 key 同一份
  // 表达式）标识哪一行正在归位，不再用 rel——一组现在可能有多个 stray 位置，
  // 单个 rel 字符串不再能唯一标识一行
  const [repositioningKey, setRepositioningKey] = useState<string | null>(null);
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

  // 权重卡视图偏好（任务 19）：模块级 store + useSyncExternalStore，与
  // models-table.tsx 的 modelSortStore 接线同一套写法——挂载后的 effect 只
  // 调用 hydrate()，不直接 setState，避免 react-hooks/set-state-in-effect
  const weightsView = useSyncExternalStore(
    repoWeightsViewStore.subscribe,
    repoWeightsViewStore.getSnapshot,
    repoWeightsViewStore.getServerSnapshot,
  );
  useEffect(() => {
    repoWeightsViewStore.hydrate();
  }, []);

  // 深度扫描（任务 15）：scanResult 是「下载选中项」弹确认层前置的候选匹配，
  // 不入库（POST /scan 本身不落地，见该路由头注释），只在当前会话内存活；
  // scanBoxOpen 控制自定义目录输入框的展开/折叠，收起时不清空已填的文本，
  // 免得用户手滑碰到折叠按钮就要重填一遍
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanBoxOpen, setScanBoxOpen] = useState(false);
  // 初值取已持久化的目录：输入框现在是「当前生效范围」的可编辑视图，不是一个
  // 每次都从空白开始的追加框（清空并扫描 = 清除自定义范围，见 runScan）
  const [scanExtraDirsText, setScanExtraDirsText] = useState(scanExtraDirs.join(", "));
  // 获取确认弹层（设计 §9.1）：acquireRows 是弹层自己的行状态机（lib/acquire-plan.ts），
  // 与档案页主体的 rows（RepoRow[]）是两套并存的数据——前者只在弹层打开期间
  // 有意义，提交成功后靠下方的 SSE 订阅把执行进度喂给它
  const [acquireRows, setAcquireRows] = useState<AcquireRow[]>([]);
  const [acquireOpen, setAcquireOpen] = useState(false);
  // 本次确认提交产生的批次号：SSE 收到的全量任务快照要用它过滤出「属于这次
  // 弹层」的那些，不然同一档案里恰好同名的历史任务会串进来更新错误的行
  const [acquireBatchId, setAcquireBatchId] = useState<string | null>(null);
  // 供 SSE 回调读最新值——effect 只订阅一次连接，不能把 acquireRows/acquireBatchId
  // 放进依赖数组反复重订阅（同下方 lastGroupsRef 一带的既有理由）
  const acquireRowsRef = useRef<AcquireRow[]>([]);
  const acquireBatchIdRef = useRef<string | null>(null);
  // 本次提交里「目标已存在而没入队」的文件（acquire 响应的 skipped）：这些文件
  // 永远不会有任务推送，applyTaskUpdate 必须知道它们才能判定整组完成，否则
  // 「3 分片已存在 2 片」的组会永远停在 executing、弹层也关不掉
  const acquireSkippedRef = useRef<string[]>([]);

  // 「更新到最新版」确认框（任务 15）：比 acquireRows 那整套弹层轻——这里没有
  // 本地获取的选择余地，动作恒为 download，只需要一个待确认的行 + 提交中标记。
  // 复核 F-1：连 index 一起存——提交时不能只凭 row 本身（quant, kind）去
  // `data.remote.groups` 里 find，见下方 onConfirmUpdate 的详细说明
  const [updateTarget, setUpdateTarget] = useState<{ row: RepoRow; index: number } | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);

  // 手动关联（复核修复 F-1/F-7）：父组件集中管理一个受控的 ModelFilePicker 实例。
  // manualLinkTarget 记录用户当前正在关联哪一个远端文件——分片组要能指定具体
  // 哪一片（F-1），弹层受控 open 由它是否非空驱动，由 onRequestManualLink 决定
  // 要不要先扫描再打开（F-7）
  const [manualLinkTarget, setManualLinkTarget] = useState<{ row: RepoRow; remoteFile: RemoteFile } | null>(null);
  const [manualLinkBusy, setManualLinkBusy] = useState(false);

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
  // 上一次拿到的远端分组（只留 sameGroupIdentity 要比对的两个字段），供
  // fetchDetails 判断这次拿回来的是不是同一份清单——不能把 data 加进
  // fetchDetails 的 useCallback 依赖来读旧值：那会让这个回调随每次数据变化
  // 而重建，进而让依赖它的 effect 反复重跑，还可能撞上开发时已经踩过的
  // react-hooks/refs、react-hooks/set-state-in-effect 那两条规则；用 ref 存、
  // 在 setData 的同一处更新，读写都在事件/回调里，不在渲染期
  const lastGroupsRef = useRef<{ kind: string; files: { path: string }[] }[] | null>(null);

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
          lastGroupsRef.current !== null && newGroups !== null && sameGroupIdentity(lastGroupsRef.current, newGroups);
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

  useEffect(() => {
    acquireRowsRef.current = acquireRows;
  }, [acquireRows]);

  useEffect(() => {
    acquireBatchIdRef.current = acquireBatchId;
  }, [acquireBatchId]);

  // 获取确认弹层的进度来源：复用下载页同一条 downloads SSE 端点
  // （lib/shared-event-source.ts 按 URL 去重连接，本订阅不会新开一条物理连接）。
  // 只订阅一次（不随 acquireBatchId 变化重订阅），过滤与折算全部在 onData 里
  // 用 ref 读最新值——effect 依赖数组保持稳定，避免每次提交新一批都要重连一次
  useEffect(() => {
    const unsubscribe = subscribeStream("/api/v1/downloads/stream", {
      onData: (raw) => {
        const batchId = acquireBatchIdRef.current;
        if (batchId === null) return;
        let msg: { type?: string; tasks?: AcquireTaskSnapshot[] };
        try {
          msg = JSON.parse(raw);
        } catch {
          return; // 半截帧：丢弃等下一拍（1s 节拍自愈，与 downloads-view.tsx 同款容错）
        }
        if (msg.type !== "tasks" || !Array.isArray(msg.tasks)) return;
        const updates = msg.tasks
          .filter((task) => task.batchId === batchId)
          .map((task) => ({
            file: task.file,
            status: task.status,
            downloadedBytes: task.downloadedBytes,
            totalBytes: task.expectedSize ?? 0,
            error: task.error ?? undefined,
          }));
        if (updates.length === 0) return;

        const prev = acquireRowsRef.current;
        const next = applyTaskUpdate(prev, updates, acquireSkippedRef.current);
        acquireRowsRef.current = next;
        setAcquireRows(next);
        // 一旦有行完成，背后卡片网格（present/stray 等状态）就已经过期——
        // 只在「新出现一个 done」这个转折点重取一次，不必每拍都刷
        if (next.some((row, i) => row.phase === "done" && prev[i]?.phase !== "done")) {
          void fetchDetails();
        }
      },
    });
    return unsubscribe;
  }, [fetchDetails]);

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
  // 分组视图用的目录信息：RepoRow.files 在 mergeRepoRows 里已按 basename 收窄
  // （供与 tasks/local 按名匹配用），本身从不带目录前缀。groupRowsByDir 内部
  // 会用 remoteGroups 的完整相对路径回填目录后再分组（复核修复 G-2：回填这
  // 一步挪进函数内部，remoteGroups 改为必填参数，接线层从此写不出"跳过回填"
  // 这种退化）——渲染仍一律回到 rows[entry.index] 取真身，entries 不再携带
  // row 本身，"用回填后的克隆行去渲染"这条退化在类型层就写不出来
  const dirGroups: RepoDirGroup[] = groupRowsByDir(rows, data?.remote.ok ? data.remote.groups : undefined);
  const showSubdirs = hasSubdirs(dirGroups);
  // 手动关联候选池的原始文件列表（复核修复 F-1/F-7：改为父组件集中管理一个受控
  // 的 ModelFilePicker，QuantCard 只负责渲染入口按钮并把点击事件报告给父组件）：
  // 只转换不排序——排序（prefer）依赖用户具体点了哪个远端文件，要等
  // manualLinkTarget 确定后才能算，见下方 manualLinkPickerItems
  const manualLinkFiles: PickerFile[] | null =
    scanResult === null
      ? null
      : scanResult.unarchived
          .filter((c): c is LocalCandidate & { rel: string } => c.rel !== null)
          // 候选池（LocalCandidate）不带 mtime，此字段在选择器里未被使用，填 0
          .map((c) => ({ rel: c.rel, size: c.size, mtime: 0, refs: c.referenced ? 1 : 0 }));

  const manualLinkPickerItems: PickerItem[] =
    manualLinkFiles === null || manualLinkTarget === null
      ? []
      : buildPickerItems(manualLinkFiles, {
          mode: "file",
          prefer: { basename: basename(manualLinkTarget.remoteFile.path), size: manualLinkTarget.remoteFile.size },
        });

  // strays[] 的 rel → drift 映射（任务 14 步骤 2）：RepoRow 只聚合到组级的
  // hasUpdate/unverified 两个布尔值（repo-files-view.ts 本次不改），要判断
  // 「散落位置里具体是哪个文件版本不符」得回到原始响应按 rel 查表，QuantCard
  // 拿着 row.strayRels 逐个查
  const strayDriftByRel = new Map((data?.strays ?? []).map((s) => [s.rel, s.drift]));

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
  // 与页头汇总同一个数：summarizeRepoRows 的 totalBytes 已按 inode 去重
  // （硬链接来的文件在档案内可能有两条路径，磁盘只占一份），删除弹层的
  // 「将释放 X」不该报一个双倍的数
  const occupiedBytes = summary?.totalBytes ?? 0;

  function toggleSelect(index: number, checked: boolean): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(index);
      else next.delete(index);
      return next;
    });
  }

  /** 深度扫描核心逻辑：onScan（页头按钮）与 onDownloadSelected（scanResult 缺失
   *  时的兜底自扫）共用，失败一律 toast 提示、返回 null 交给调用方各自决定
   *  要不要继续（onScan 到此为止；onDownloadSelected 直接 return，不打开一个
   *  空弹层） */
  async function runScan(): Promise<ScanResult | null> {
    const extraDirs = parseScanExtraDirs(scanExtraDirsText);
    const res = await apiFetch(`/api/v1/repos/${profile.id}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 始终显式发送：输入框已经回填了当前生效的范围，它的内容就是用户想要的
      // 范围，空数组即「清除自定义目录」。此前「空就不发这个键」使得清空输入框
      // 根本删不掉已持久化的目录（服务端会退回旧值），与上面注释说的正好相反
      body: JSON.stringify({ extraDirs }),
    }).catch(() => null);

    if (res === null) {
      toast.error(t("errorNetwork"));
      return null;
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
      toast.error(body?.message ?? body?.error ?? t("errorRequest"));
      return null;
    }
    const body = (await res.json()) as ScanResult;
    setScanResult(body);
    return body;
  }

  async function onScan(): Promise<void> {
    if (scanBusy) return;
    setScanBusy(true);
    await runScan();
    setScanBusy(false);
  }

  async function onDownloadSelected(): Promise<void> {
    if (data === null || !data.remote.ok || selected.size === 0 || downloadBusy) return;
    // 用回填过目录的那份行（buildGroupingRows）而不是 rows：RepoRow.files 在
    // mergeRepoRows 里按 basename 收窄，而 matchScannedGroups 的身份是「组内
    // 文件名列表」——带上目录才能精确匹配到扫描结果里的同一组。同一个
    // (quant, kind) 下可以有多组（真机的根目录 Q4_0 与 MTP/ 下的 Q4_0），
    // 这一步不做，弹层会把同量化的另一组也一起列出来
    const groupingRows = buildGroupingRows(rows, data.remote.groups);
    const picked = [...selected].map((i) => groupingRows[i]!);

    setDownloadBusy(true);
    // 用户没手动点过「扫描」时这里补一次——不然弹层会因为 scanResult 为 null
    // 而拿到空 groups，把「下载选中项」这个既有入口变成一个打不开东西的死按钮
    const result = scanResult ?? (await runScan());
    setDownloadBusy(false);
    if (result === null) return;

    setAcquireRows(buildRows(matchScannedGroups(picked, result.groups)));
    setAcquireOpen(true);
    // 每次重新打开弹层都是一次全新的确认会话——上一批（哪怕整批失败、
    // 从未清空过）的批次号不能带进来，否则下方 SSE 订阅会拿旧批次的
    // failed 状态去套还没提交过的新行（复核修复：全批失败后关闭弹层、
    // 对同一文件重新点「下载选中项」会复现）。skipped 名单同理，它属于
    // 上一次提交
    setAcquireBatchId(null);
    acquireSkippedRef.current = [];
  }

  /** 点击某个具体远端文件的手动关联入口（复核修复 F-1/F-7）：没扫描过时先补
   *  一次深度扫描（与 onDownloadSelected 现有的 `scanResult ?? (await runScan())`
   *  同一条既有路子），再把弹层的受控 open 状态打开、定位到这个远端文件 */
  async function onRequestManualLink(row: RepoRow, remoteFile: RemoteFile): Promise<void> {
    if (manualLinkBusy) return;
    let result = scanResult;
    if (result === null) {
      setManualLinkBusy(true);
      result = await runScan();
      setManualLinkBusy(false);
      if (result === null) return;
    }
    setManualLinkTarget({ row, remoteFile });
  }

  /** 执行中不许关闭弹层（右上角 X / Esc）：与 repo-dialogs.tsx 的 MoveDialog/
   *  DeleteDialog 同款守卫写法，只是这里判据换成「有没有行在跑」。逃生口是
   *  弹层底部的「转入后台」（onAcquireRunInBackground），不是把守卫放宽 */
  function onAcquireOpenChange(next: boolean): void {
    if (!next && hasExecutingRow(acquireRows)) return;
    setAcquireOpen(next);
  }

  /** 转入后台：任务继续在队列里跑（下载页可见），只是不再占着这个弹层 */
  function onAcquireRunInBackground(): void {
    setAcquireOpen(false);
  }

  async function onAcquireSubmit(): Promise<void> {
    const items = buildAcquireSubmitItems(acquireRows);
    const res = await apiFetch(`/api/v1/repos/${profile.id}/acquire`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    }).catch(() => null);

    if (res === null) {
      toast.error(t("errorNetwork"));
      return;
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
      toast.error(body?.message ?? body?.error ?? t("errorRequest"));
      return;
    }
    const body = (await res.json()) as {
      batchId: string;
      downloads: number;
      locals: number;
      skipped?: string[];
    };
    // 落地批次号后靠已有的 downloads SSE 订阅推动 applyTaskUpdate 刷新弹层行状态；
    // 这里额外刷一次背后的卡片网格——与旧的直接下载流程同一条收尾（入队后
    // 立刻能看到卡片翻到「下载中」），并顺带把 selected 里已经排进队列的
    // 下标剪掉（retainedSelection 按 isSelectable 判定），避免重复提交
    const skipped = body.skipped ?? [];
    acquireSkippedRef.current = skipped;
    setAcquireBatchId(body.batchId);
    // 立刻把 skipped 折算进行状态：整组都被跳过时一条任务推送都不会来，
    // 不在这里推一次，那些行会永远停在 idle
    const next = applyTaskUpdate(acquireRowsRef.current, [], skipped);
    acquireRowsRef.current = next;
    setAcquireRows(next);
    // 计数报的是真正入队的任务数，不是提交的条目数——跳过的那些没有任务，
    // 说成「已加入队列 3 个」用户去下载页只看得到 1 个
    toast.success(t("downloadQueued", { count: body.downloads + body.locals - skipped.length }));
    await fetchDetails();
  }

  /** 弹层受控关闭：提交请求飞行途中不许被 Esc / 背景点击打断——那条请求本身
   *  很短（只是入队），但打断后 updateTarget 被清空，用户再点一次「更新到最新版」
   *  会在同一行开出第二个弹层，两次提交都在飞 */
  function onUpdateOpenChange(next: boolean): void {
    if (!next && updateBusy) return;
    if (!next) setUpdateTarget(null);
  }

  /**
   * 「更新到最新版」确认提交（任务 15）：与「下载选中项」不同，这里不必再打一次
   * 深度扫描——直接把该组在远端清单里的全部文件按 download 重新入队，服务端
   * 见到目标已存在但内容未必匹配时的既有覆盖逻辑负责真正落盘。
   *
   * 复核 F-1（Critical）：remoteGroup 曾经按 `(quant, kind)` 在 `data.remote.groups`
   * 里 `find`，但 `(quant, kind)` 不是组身份——`core/quant.ts` 的分组键还带
   * `shardKey`，同一量化下可能有多套模型各自成组（同仓库两个非分片 Q4_K_M，
   * 或都是「未识别」的多文件仓库）。`find` 命中的是第一个匹配的组，用户在
   * 第二张卡点「更新」时，确认框显示的文件数是对的（来自 row 本身），但提交
   * 的却是第一个同名组的文件——会把不该覆盖的文件重新下载覆盖掉，且因为
   * `locked` 判的是被点的那一行、不是实际提交的那一行，`lockedRels` 这道
   * 运行中占用锁会被整条绕过。
   *
   * 改为按 index 直接从 `data.remote.groups[index]` 取——`repo-files-view.ts`
   * 的 `mergeRepoRows` 用 `input.groups.map(...)` 逐组产出一行，下标与
   * `remote.groups` 严格一一对应。但这只是当前实现的性质，不是类型系统保证
   * 的不变量：加一道文件名断言（basename 逐个比对），万一将来 mergeRepoRows
   * 里加了过滤/排序导致这个假设静默失效，这里会报错而不是悄悄覆盖错文件。
   * 判据复用 `matchedRemoteGroup`（复核修复 G-4）——与 `buildGroupingRows`/
   * 手动关联的 `manualLinkRemoteFiles` 共用同一处判据来源，不再各自维护
   * 一份容易漂移的比对逻辑。
   */
  async function onConfirmUpdate(): Promise<void> {
    if (updateTarget === null || updateBusy) return;
    const { row, index } = updateTarget;
    const remoteGroup = matchedRemoteGroup(row, data?.remote.ok ? data.remote.groups : null, index);
    if (remoteGroup === null) {
      toast.error(t("errorRequest"));
      setUpdateTarget(null);
      return;
    }

    setUpdateBusy(true);
    const items = remoteGroup.files.map((f) => ({ file: f.path, action: "download" as const }));
    const res = await apiFetch(`/api/v1/repos/${profile.id}/acquire`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    }).catch(() => null);
    setUpdateBusy(false);
    setUpdateTarget(null);

    if (res === null) {
      toast.error(t("errorNetwork"));
      return;
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
      toast.error(body?.message ?? body?.error ?? t("errorRequest"));
      return;
    }
    const body = (await res.json()) as { batchId: string; downloads: number; locals: number; skipped?: string[] };
    const skipped = body.skipped ?? [];
    const count = body.downloads + body.locals - skipped.length;
    // 复核 F-3（Important）：drift 判「different」有两条路——size 不等，或者
    // size 相等而 oid 不等。覆盖靠的入队判据（partitionExistingTargets）只
    // 看 size，size 相等的那一路会被整批 skip：downloads=0、locals=0，
    // count 恒为 0。此时报 success「已加入下载队列（0 个文件）」是误导——
    // 请求确实成功了，但什么都没发生，用户唯一能看到的信号是括号里那个 0。
    // 改判：count 为 0 且确实有文件被跳过时，换一条如实说明原因 + 给出出路
    // 的提示（这一半只改前端"如实报告"，"给下载队列加强制覆盖开关"是服务端
    // 能力，超出这两个前端任务范围，本轮不做）
    //
    // 复核修复 K-3：部分跳过比全部跳过更危险——用户拿到的是新旧混版的分片
    // 集，llama.cpp 加载会失败或读出垃圾，界面却报 success。必须把被跳过的
    // 文件名列出来，用户才知道该删哪个再重新更新
    if (skipped.length > 0) {
      if (count === 0) {
        toast.error(t("updateAllSkipped"));
      } else {
        toast.error(t("updatePartialSkipped", { files: skipped.join(", ") }));
      }
    } else {
      toast.success(t("downloadQueued", { count }));
    }
    await fetchDetails();
  }

  async function onReposition(row: RepoRow): Promise<void> {
    // planFileMove 本就整组搬（设计 §2 现状表）：一组多个散落位置只需要挑出
    // 一个当 from，服务端按 basename 归位整组。必须取**可归位**的那一路：
    // strayRels 自任务 11 起混装了「落在别的档案目录里」的文件，planFileMove
    // 对这类 from 直接 INVALID_PATH 400（档案目录内的文件不能单独移出）
    const from = row.relocatableRels[0];
    if (from === undefined || repositioningKey !== null) return;
    setRepositioningKey(rowKey(row));
    const res = await apiFetch("/api/v1/files/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, toFolder: freshProfile.targetDir }),
    }).catch(() => null);
    setRepositioningKey(null);

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

  /**
   * 手动关联提交（规格 §7）：把用户挑的本机候选包成一条 manual 的 AcquireRow，
   * 并入既有 acquireRows 打开确认弹层——复用同一条提交与进度链路，不另起一套。
   * 文件级 actions 直接取行级同一个数组（而不是简报字面量给的四选一列表）：
   * buildAcquireSubmitItems 对 manual 行只看行级 actions，两份不一致纯属埋雷。
   *
   * 复核修复 F-1：远端文件不再需要靠 index 反查 remoteGroup.files[0]——分片组
   * 现在逐文件关联，具体关联哪一个远端文件由 onRequestManualLink 记进
   * manualLinkTarget，这里直接拿参数。
   */
  function onManualLink(row: RepoRow, remoteFile: string, candidateRel: string): void {
    const candidate = scanResult?.unarchived.find((c) => c.rel === candidateRel);
    if (candidate === undefined) return;

    // 复核修复 K-6：动作数组此前手写顺序（download, link, move[-with-refs]），
    // 与 acquire-match.ts 的 ACTION_ORDER（download, move[-with-refs], link,
    // copy）不一致——同一批弹层里手动关联行的下拉顺序会跟其它行错位。改为
    // 按 ACTION_ORDER 过滤出允许的动作，顺序与全站其它入口统一
    const allowed: readonly AcquireAction[] = candidate.referenced
      ? ["download", "move-with-refs", "link"]
      : ["download", "move", "link"];
    const rowActions: AcquireAction[] = ACTION_ORDER.filter((a) => allowed.includes(a));
    const manualRow: AcquireRow = {
      quant: row.quant,
      kind: row.kind,
      files: [
        {
          file: remoteFile,
          candidate,
          drift: "different",
          actions: rowActions,
          defaultAction: "link",
          restriction: "none",
        },
      ],
      action: "link",
      actions: rowActions,
      restriction: "none",
      phase: "idle",
      progress: null,
      error: null,
      canFallbackToDownload: false,
      manual: true,
    };
    setAcquireRows((prev) => (acquireOpen ? [...prev, manualRow] : [manualRow]));
    if (!acquireOpen) {
      setAcquireBatchId(null);
      acquireSkippedRef.current = [];
    }
    setAcquireOpen(true);
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
                {scanResult !== null && scanResult.unreachable.length > 0 && (
                  <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-sm text-amber-700 dark:text-amber-400">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                    <div className="flex flex-1 flex-col gap-1 font-mono text-xs">
                      <span>{t("scanUnreachable", { paths: scanResult.unreachable.join(", ") })}</span>
                      {scanResult.availableMounts.length > 0 && (
                        <span>
                          {t("scanAvailableMounts", { paths: scanResult.availableMounts.map((m) => m.host).join(", ") })}
                        </span>
                      )}
                    </div>
                  </div>
                )}

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

                {/* 头部工具条并成一行：左边摘要 + 远端缓存状态，右边视图切换 / 扫描 /
                    刷新。原先是三行（刷新独占一行、摘要+扫描一行、视图切换又一行），
                    每行右侧都是一小撮按钮、中间大片空白，把权重网格压到了首屏之下。
                    flex-wrap 保底：窄屏时右侧按钮整体换行，不会把摘要挤没。
                    扫描按钮仍不受 data.remote.ok 约束——远端不可达恰恰是本地迁移
                    最有价值的场景（HF 打不开、但盘上已经躺着一份权重），跟着远端
                    状态一起消失就等于把功能关在门外 */}
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <p className="font-mono">
                      {t("summaryLine", {
                        targetDir,
                        quantCount: summary.quantCount,
                        downloaded: summary.downloadedCount,
                        size: formatSize(summary.totalBytes),
                      })}
                    </p>
                    {data.remote.ok &&
                      (remoteRefreshing ? (
                        <span className="flex items-center gap-1.5">
                          <Loader2 className="size-3 animate-spin" />
                          {t("remoteRefreshing")}
                        </span>
                      ) : (
                        <>
                          {data.remote.stale && (
                            <span>
                              {t("remoteCachedAt", { time: new Date(data.remote.fetchedAt).toLocaleString() })}
                            </span>
                          )}
                          {data.remote.error !== null && <span>{t("remoteRefreshFailed")}</span>}
                        </>
                      ))}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {/* 视图切换从权重网格上方挪到这里。多带两个条件：目录不存在或
                        一条权重都没有时，下方根本没有网格可切，留着是个空开关 */}
                    {dirExists && rows.length > 0 && showSubdirs && (
                      <Tabs
                        value={weightsView}
                        onValueChange={(v) => repoWeightsViewStore.setValue(v as RepoWeightsView)}
                      >
                        <TabsList aria-label={t("viewSwitchLabel")}>
                          <TabsTrigger value="grouped">{t("viewGrouped")}</TabsTrigger>
                          <TabsTrigger value="flat">{t("viewFlat")}</TabsTrigger>
                        </TabsList>
                      </Tabs>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-muted-foreground"
                      aria-label={t("scanExtraDirLabel")}
                      aria-expanded={scanBoxOpen}
                      onClick={() => setScanBoxOpen((open) => !open)}
                    >
                      {scanBoxOpen ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                    </Button>
                    <Button size="sm" variant="outline" disabled={scanBusy} onClick={() => void onScan()}>
                      {scanBusy ? <Loader2 className="size-3.5 animate-spin" /> : <ScanSearch className="size-3.5" />}
                      {scanBusy ? t("scanning") : t("scanAction")}
                    </Button>
                    {data.remote.ok && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={remoteRefreshing}
                        onClick={() => void onManualRemoteRefresh()}
                      >
                        {remoteRefreshing ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="size-3.5" />
                        )}
                        {t("readmeRefresh")}
                      </Button>
                    )}
                  </div>
                </div>

                {scanBoxOpen && (
                  <Input
                    value={scanExtraDirsText}
                    onChange={(e) => setScanExtraDirsText(e.target.value)}
                    placeholder={t("scanExtraDirLabel")}
                    className="h-8 font-mono text-xs"
                  />
                )}

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
                      <>
                        {!showSubdirs || weightsView === "flat" ? (
                          <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
                            {rows.map((row, index) => (
                              <QuantCard
                                key={rowKey(row)}
                                row={row}
                                index={index}
                                showCheckbox={data.remote.ok}
                                selected={selected.has(index)}
                                onToggleSelect={toggleSelect}
                                dirExists={dirExists}
                                repositioning={row.strayRels.length > 0 && repositioningKey === rowKey(row)}
                                onReposition={() => void onReposition(row)}
                                strayDriftByRel={strayDriftByRel}
                                lockedRels={data.lockedRels}
                                onRequestUpdate={(r) => setUpdateTarget({ row: r, index })}
                                manualLinkRemoteFiles={
                                  data.remote.ok ? (matchedRemoteGroup(row, data.remote.groups, index)?.files ?? null) : null
                                }
                                manualLinkBusy={manualLinkBusy}
                                onRequestManualLink={(remoteFile) => void onRequestManualLink(row, remoteFile)}
                              />
                            ))}
                          </div>
                        ) : (
                          <div className="space-y-4">
                            {dirGroups.map((group) => (
                              <div key={group.dir} className="space-y-2">
                                <p className="font-mono text-xs text-muted-foreground">
                                  {group.dir === "" ? t("rootDir") : group.dir}
                                </p>
                                <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
                                  {group.entries.map((entry) => {
                                    const row = rows[entry.index]!;
                                    return (
                                      <QuantCard
                                        key={rowKey(row)}
                                        row={row}
                                        index={entry.index}
                                        showCheckbox={data.remote.ok}
                                        selected={selected.has(entry.index)}
                                        onToggleSelect={toggleSelect}
                                        dirExists={dirExists}
                                        repositioning={row.strayRels.length > 0 && repositioningKey === rowKey(row)}
                                        onReposition={() => void onReposition(row)}
                                        strayDriftByRel={strayDriftByRel}
                                        lockedRels={data.lockedRels}
                                        onRequestUpdate={(r) => setUpdateTarget({ row: r, index: entry.index })}
                                        manualLinkRemoteFiles={
                                          data.remote.ok
                                            ? (matchedRemoteGroup(row, data.remote.groups, entry.index)?.files ?? null)
                                            : null
                                        }
                                        manualLinkBusy={manualLinkBusy}
                                        onRequestManualLink={(remoteFile) => void onRequestManualLink(row, remoteFile)}
                                      />
                                    );
                                  })}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </>
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

                    <AcquireDialog
                      open={acquireOpen}
                      rows={acquireRows}
                      onOpenChange={onAcquireOpenChange}
                      onChangeAction={(key, action) =>
                        setAcquireRows((prev) =>
                          prev.map((row) => (groupKey(row) === key ? { ...row, action } : row)),
                        )
                      }
                      onSubmit={() => void onAcquireSubmit()}
                      onRunInBackground={onAcquireRunInBackground}
                    />

                    <Dialog open={updateTarget !== null} onOpenChange={onUpdateOpenChange}>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>{t("updateConfirmTitle")}</DialogTitle>
                          <DialogDescription>
                            {updateTarget !== null &&
                              (updateTarget.row.models.length > 0
                                ? t("updateConfirmBody", {
                                    count: updateTarget.row.files.length,
                                    models: updateTarget.row.models.join(", "),
                                  })
                                : t("updateConfirmNoRefs", { count: updateTarget.row.files.length }))}
                          </DialogDescription>
                        </DialogHeader>
                        <DialogFooter>
                          {/* 复核 F-5：这是个会覆盖本地几十 GB 文件的确认框，右上角 X
                              不该是唯一显式退路——照同目录 repo-dialogs.tsx 的
                              MoveDialog/DeleteDialog 补一个取消按钮。确认按钮换成
                              独立的 updateConfirmAction 键，不再跟标题重复同一句话 */}
                          <DialogClose render={<Button variant="outline" disabled={updateBusy} />}>
                            {t("updateConfirmCancel")}
                          </DialogClose>
                          <Button disabled={updateBusy} onClick={() => void onConfirmUpdate()}>
                            {updateBusy ? <Loader2 className="animate-spin" /> : <RefreshCw className="size-3.5" />}
                            {t("updateConfirmAction")}
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>

                    {/* 手动关联弹层（复核修复 F-1/F-7）：父组件集中管理的唯一一份受控
                        ModelFilePicker——各 QuantCard 只上报点击了哪个远端文件，
                        不再各自内嵌一份自管理的实例 */}
                    <ModelFilePicker
                      items={manualLinkPickerItems}
                      field={manualLinkTarget?.row.kind === "mmproj" ? "mmproj" : "gguf"}
                      namespace="pages.repos"
                      open={manualLinkTarget !== null}
                      onOpenChange={(next) => {
                        if (!next) setManualLinkTarget(null);
                      }}
                      descriptionParams={
                        manualLinkTarget ? { remote: basename(manualLinkTarget.remoteFile.path) } : undefined
                      }
                      onSelect={(value) => {
                        if (manualLinkTarget) onManualLink(manualLinkTarget.row, manualLinkTarget.remoteFile.path, value);
                        setManualLinkTarget(null);
                      }}
                    />
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

/**
 * localSize/remoteSize 的带符号差值转文案（复核修复 K-1，从版本漂移设计
 * 恢复——F-2 复核当时删掉这套是对的：那时唯一数据源是组级聚合，差值恒错；
 * 现在数据源是 row.driftStrays 里逐文件的实测 size，差值真实且有意义）
 */
function driftDeltaText(localSize: number, remoteSize: number, t: ReturnType<typeof useTranslations>): string {
  const diff = localSize - remoteSize;
  const size = formatSize(Math.abs(diff));
  return diff > 0 ? t("driftDeltaLarger", { size }) : t("driftDeltaSmaller", { size });
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
  strayDriftByRel,
  lockedRels,
  onRequestUpdate,
  manualLinkRemoteFiles,
  manualLinkBusy,
  onRequestManualLink,
}: {
  row: RepoRow;
  index: number;
  showCheckbox: boolean;
  selected: boolean;
  onToggleSelect: (index: number, checked: boolean) => void;
  dirExists: boolean;
  repositioning: boolean;
  onReposition: () => void;
  /** 全档案 strays[] 的 rel → drift 映射（任务 14 步骤 2）：repo-files-view.ts
   *  的 RepoRow 只聚合到组级的 hasUpdate/unverified 两个布尔值，没有逐个散落
   *  文件的版本关系，要判断「这组的散落位置里具体是哪个文件版本不符」得回到
   *  原始响应按 rel 查，本组件拿着 row.strayRels 逐个查这张表 */
  strayDriftByRel: ReadonlyMap<string, DriftState | undefined>;
  /** 当前运行中模型占用的文件（任务 15），models 根相对路径 */
  lockedRels: readonly string[];
  /** 「更新到最新版」按钮点击：把这一行交给父组件打开确认框——父组件持有
   *  data.remote.groups，提交时才需要按 (quant, kind) 找回完整远端路径 */
  onRequestUpdate: (row: RepoRow) => void;
  /** 该行对应远端组的全部文件（含目录），用于算出"尚缺哪些分片"；null 表示
   *  remote 不可达或下标对不上，此时不渲染入口（复核修复 F-1/F-7） */
  manualLinkRemoteFiles: readonly RemoteFile[] | null;
  /** 深度扫描是否正在补跑（F-7）：进行中禁用全部手动关联按钮，避免重复触发 */
  manualLinkBusy: boolean;
  /** 点击某个具体远端文件的手动关联入口；父组件决定要不要先扫描（见 F-7） */
  onRequestManualLink: (remoteFile: RemoteFile) => void;
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

  // I6：partial 行也可能带 strayRels（分片组一部分在档案目录内、另一部分
  // 散落别处），条件不能只看 state === "stray"，否则这类行的操作段是空的，
  // 用户既没有归位入口，勾选下载又会重下已到齐的那片
  //
  // I1：散落位置全在别的档案目录里时禁用按钮并说明原因——planFileMove 拒绝
  // 把档案目录内的文件单独移出，点了必然 400。与 files 页「未登记」表对
  // `inRepoDir !== null` 的处理同一套判定（禁用 + title 解释）
  const onlyInOtherRepos = row.relocatableRels.length === 0;
  const repositionButton =
    row.strayRels.length > 0 ? (
      <Button
        size="sm"
        variant="outline"
        disabled={!dirExists || repositioning || onlyInOtherRepos}
        title={onlyInOtherRepos ? t("repositionDisabledInRepo") : undefined}
        onClick={(e) => {
          e.stopPropagation();
          onReposition();
        }}
      >
        {repositioning ? <Loader2 className="animate-spin" /> : <FolderSymlink className="size-3.5" />}
        {repositioning ? t("repositioning") : t("actionReposition")}
      </Button>
    ) : null;

  // 任务 15：本地这份被判定为「有更新」时给出「更新到最新版」入口。llama.cpp
  // 是 mmap 读文件的，覆盖走的是 .part 写完再 rename 的原子替换——运行中进程
  // 早先打开的文件描述符仍指向旧 inode，会一直读着覆盖前的旧内容直到重启，
  // 不会读到半新半旧的字节，但用户可能误以为"关联/更新"已经生效——
  // row.localRels 与服务端下发的 lockedRels 有交集就禁用并解释原因，不是
  // 拦在提交那一刻才报错
  const locked = row.localRels.some((rel) => lockedRels.includes(rel));
  // 复核 F-6（Minor）：hasUpdate 与 state 是两个独立算出来的字段——一个多分片
  // 组里，正在下载中的那一片会让整行 state 落 "downloading"（mergeRepoRows
  // 的 anyProgressing 优先级最高），但组内**其它已到齐、drift 为 different**
  // 的分片照样会让 hasUpdate 为 true（drift 判定只发生在没有进行中任务的
  // 那些文件上，两者互不影响）。此前按钮只看 hasUpdate，state 为
  // downloading 时它照样可点，而这组文件的目标路径此刻正有未完成任务，提交
  // 会撞上 manager.ts 的 assertNoUnfinishedAtTargets → 409，且服务端错误
  // 消息是中文，会原样透给英文用户（该问题是全站既有情况，不在本轮修复
  // 范围）。改为 state 为 downloading 时也禁用 + 给出说明。
  //
  // partial 状态不禁用：partial 恰恰是"组内没有任何文件在下载中"的那个分支
  // （anyProgressing 为 false 才会落到 partial），不存在同一个 409 风险；
  // partial 行提交更新还有实际价值——顺带把从未下载过的缺片一起补齐，不是
  // 只重下已到齐但过期的那些
  const downloading = row.state === "downloading";
  const updateButton = row.hasUpdate ? (
    <Button
      size="sm"
      variant="outline"
      disabled={locked || downloading}
      title={locked ? t("updateLockedTitle") : downloading ? t("updateDownloadingTitle") : undefined}
      onClick={(e) => {
        e.stopPropagation();
        onRequestUpdate(row);
      }}
    >
      <RefreshCw className="size-3.5" />
      {t("actionUpdate")}
    </Button>
  ) : null;

  // 任务 14 步骤 2：散落位置里只要有一个文件被判定「与远端当前版本不符」，
  // 原先什么都不显示的空白就要补一条说明。
  //
  // 复核 F-2（Important）：这条提示曾经在 row.localSize/remoteSize 都非 null
  // 时算一个「大/小 {delta}」的差值——但触发条件 strayRels 依赖
  // repo-files-view.ts 的 I4 裁定「只有 size === 远端声明大小的散落文件才会
  // 进 strayRels」，也就是说能走到 different 的那个散落文件，它与远端的大小
  // 差恒为 0（能判 different 只可能是 oid 不同那一路），而 localSize/remoteSize
  // 是**组级**聚合（已到齐分片总大小 vs 远端整组总大小），跟这一个散落文件
  // 毫无关系——这一支只要渲染出来，数字就一定不是它宣称的那个量。一律退回
  // 不带差值的文案，不再计算/展示这个误导性的数字（渲染见 driftStrayMismatchNoDelta）。
  //
  // K-1 复核修复：这与 row.driftStrays 是互补的两条判据，不重叠——strayMismatch
  // 覆盖「size 相等、oid 不等」（进了 strayRels 那一路），driftStrays 覆盖
  // 「size 就不等」（I4 精确门收不下、之前完全沉默的那一路）。driftStrays 的
  // localSize/remoteSize 是逐文件实测出来的真实差值，不是组级聚合，delta 有效。
  const strayMismatch = row.strayRels.some((rel) => strayDriftByRel.get(rel) === "different");

  // F-1 复核修复：不再要求 totalShards === 1——规格要求「分片组逐文件
  // 关联，不做整组推断」。已经在档案目录里的分片不出现在可选项里（虽然
  // absent/stray 两种状态下 row.localRels 目前恒为空，这条过滤仍按规格要求
  // 写成通用逻辑，不依赖"当前恒为空"这个巧合）
  //
  // G-1 复核修复：加 partial——分片组第一片关联后状态变成 partial，入口不能消失，
  // 否则「多分片要选多次」的第二次就没得选了。
  // G-3 复核修复：加 present && hasUpdate——规格 §7.1 原文要求「未下载」或「有
  // 更新」的行都要有这个入口；&& !locked 的理由见上文——手动关联对
  // present&&hasUpdate 行做的事情与"更新到最新版"完全一样：覆盖同一个目标
  // 路径，必须继承同一条 mmap 安全约束，否则会在"更新到最新版"明确禁止的场景
  // 下开一个功能等价的后门；locked 时既不禁用显示也不出现，与其余按钮"不适用
  // 就不渲染"的现有风格一致，不单独做成禁用+提示
  const manualLinkEligible =
    row.state === "absent" ||
    row.state === "partial" ||
    (row.state === "stray" && strayMismatch) ||
    (row.state === "present" && row.hasUpdate && !locked);
  const archivedBasenames = new Set(row.localRels.map((rel) => rel.slice(rel.lastIndexOf("/") + 1)));
  const missingRemoteFiles =
    !manualLinkEligible || manualLinkRemoteFiles === null
      ? []
      : row.state === "present"
        ? manualLinkRemoteFiles // present && hasUpdate：目标就是要覆盖的那份旧文件，不按"已归档"排除
        : manualLinkRemoteFiles.filter((f) => !archivedBasenames.has(basename(f.path)));

  // 单文件组退化成一个按钮直接指向那一个文件；分片组每个尚缺的远端文件各出
  // 一个小按钮，用户明确点哪一片就关联哪一片。没有用下拉菜单——嵌套「菜单项
  // 点击后打开另一个弹层」在 base-ui 下需要额外处理菜单关闭与弹层打开的时序
  // （常见的焦点/指针事件竞态来源），而且要为一个已经有五个既有调用方的共享
  // 组件新增受控 open 能力；本方案每个按钮各自触发同一个父级受控弹层，行为
  // 等价、实现复杂度低得多
  const manualLinkButton =
    missingRemoteFiles.length === 0 ? null : missingRemoteFiles.length === 1 ? (
      <Button
        size="sm"
        variant="outline"
        type="button"
        disabled={manualLinkBusy}
        onClick={(e) => {
          e.stopPropagation();
          onRequestManualLink(missingRemoteFiles[0]!);
        }}
      >
        {manualLinkBusy ? <Loader2 className="size-3.5 animate-spin" /> : <FolderInput className="size-3.5" />}
        {t("actionManualLink")}
      </Button>
    ) : (
      // 分片组每片一个按钮，但按钮里只放分片序号（`#1`）而不是整条文件名：
      // 名字长到 `Qwen3.8-27B-BF16-00001-of-00002.gguf` 这个量级时每个按钮
      // 独占一整行，一张 2 分片的卡就比同排其它卡高出一倍——真机截图里
      // BF16 那张卡正是这样。完整文件名收进 title，鼠标停上去仍看得到；
      // 认不出分片序号的（不守 -0000N-of-0000M 命名）退回显示 basename
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className="text-[11px] text-muted-foreground"
          onClick={(e) => e.stopPropagation()}
        >
          {t("actionManualLink")}
        </span>
        {missingRemoteFiles.map((f) => {
          const name = basename(f.path);
          const index = shardInfo(name)?.index ?? null;
          return (
            <Button
              key={f.path}
              size="sm"
              variant="outline"
              type="button"
              title={name}
              className="h-6 px-1.5 font-mono text-[11px]"
              disabled={manualLinkBusy}
              onClick={(e) => {
                e.stopPropagation();
                onRequestManualLink(f);
              }}
            >
              {index === null ? name : `#${index}`}
            </Button>
          );
        })}
      </div>
    );

  // driftStrays 与 strayMismatch 是互补的两条判据（见上文 K-1 注释），
  // 同时最多命中一条：前者有实测差值、文案带「大 N MB」，后者只能说"版本不符"。
  // 整句原先直接铺在卡片底部，在窄卡里要折两行、是整张卡最吵的一块，而它表达
  // 的只是一条旁注（不影响能不能下载）——收进感叹号，与 StrayMark 同款处理
  const driftText =
    row.driftStrays.length > 0
      ? t("driftStrayMismatch", {
          delta: driftDeltaText(row.driftStrays[0]!.localSize, row.driftStrays[0]!.remoteSize, t),
        })
      : strayMismatch
        ? t("driftStrayMismatchNoDelta")
        : null;

  const hasActions =
    createConfigButton !== null ||
    repositionButton !== null ||
    updateButton !== null ||
    manualLinkButton !== null ||
    row.state === "stray" ||
    driftText !== null;

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
        {/* I1：设计 §9.1「在另一档案」——这类文件不能移出，只能链接过来，
            标签与 files 页「未登记」表的 unclaimedBadgeInRepo 同一口径 */}
        {row.strayRepoDirs.length > 0 && (
          <Badge
            variant="outline"
            title={row.strayRepoDirs.map((dir) => t("strayInRepoAt", { repo: dir })).join(" / ")}
            className="h-4.5 px-1.5 font-sans text-[10px] leading-none text-muted-foreground"
          >
            {t("strayInRepoBadge")}
          </Badge>
        )}
        {row.sharedWith.length > 0 && <SharedWithMark paths={row.sharedWith} />}
        <span className="ml-auto font-mono text-xs text-muted-foreground">{formatSize(row.totalSize)}</span>
      </div>

      <StateCell row={row} />

      {/* 告警 + 操作合成一个页脚，`mt-auto` 把它顶到卡片底边：卡片是网格项，
          同一排的高度由最高那张决定，不这么钉住的话每张卡的按钮各自浮在
          自己内容的下方、一排看过去高低错落。告警排在按钮之前——先说问题、
          再给处理入口 */}
      {hasActions && (
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-0.5">
          {createConfigButton}
          {repositionButton}
          {updateButton}
          {manualLinkButton}
          {row.state === "stray" && <StrayMark row={row} />}
          {driftText !== null && <AlertMark label={driftText}>{driftText}</AlertMark>}
        </div>
      )}
    </div>
  );
}

/**
 * 一行的展示名：分片组取剥掉 `-0000N-of-0000M` 后的共同前缀，单文件取原路径。
 * RepoRow.files 在 mergeRepoRows 里已按 basename 收窄（供与 tasks/local 按名匹配），
 * 本身不带目录前缀——同一仓库不同目录下的同名档在这里没法靠文件名区分，这个区分
 * 职责由分组视图的目录标题承担（任务 19）；平铺视图下这仍是已知的边界情况。
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
/**
 * 卡片上的感叹号标记外壳：一个感叹号图标，详情全部收进悬停气泡。
 * 「在别处」（{@link StrayMark}）与「版本不符」共用——两者都是占地一整行、
 * 却只是旁注的长句子，铺在窄卡片里比按钮还显眼。`label` 给 aria（单个字符串，
 * 装不下气泡里的多行结构），`children` 是气泡里真正展示的内容。
 */
function AlertMark({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            // 卡片整体可点选，这个按钮的点击不该连带切换选中状态
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-amber-600 transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring dark:text-amber-400"
          />
        }
      >
        <TriangleAlert className="size-4" />
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{children}</TooltipContent>
    </Tooltip>
  );
}

function StrayMark({ row }: { row: RepoRow }) {
  const t = useTranslations("pages.repos");
  // aria-label 是单个字符串，装不下 Tooltip 那样逐条 <span>——多个位置用
  // 「/」拼接成一行，屏幕阅读器仍能读出全部路径
  const detail = [
    t("stateStray"),
    ...row.strayRels.map((rel) => t("strayAt", { dir: rel })),
    ...row.strayRepoDirs.map((dir) => t("strayInRepoAt", { repo: dir })),
  ].join(" · ");

  return (
    <AlertMark label={detail}>
      <span className="font-medium">{t("stateStray")}</span>
      {row.strayRels.map((rel) => (
        <span key={rel} className="mt-0.5 block font-mono break-all">
          {t("strayAt", { dir: rel })}
        </span>
      ))}
      {/* 落在别的档案目录里的那些：说清「不是没归位，是不能归位」 */}
      {row.strayRepoDirs.map((dir) => (
        <span key={dir} className="mt-0.5 block break-all">
          {t("strayInRepoAt", { repo: dir })}
        </span>
      ))}
    </AlertMark>
  );
}

/**
 * 硬链接共用标注（设计 §9.1，任务 15）：放在徽章行（量化/mmproj/分片数那
 * 一行，大小读数之前），沿用同一套 Badge 形态，只是可见内容只有一个
 * Link2 图标——共用路径本身走 Tooltip，与 StrayMark 同一个套路，不把完整
 * 路径直接摆进窄卡里撑宽这一行。
 */
function SharedWithMark({ paths }: { paths: readonly string[] }) {
  const t = useTranslations("pages.repos");

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            variant="outline"
            aria-label={paths.map((p) => t("acquireLinkSharedWith", { path: p })).join(" / ")}
            className="h-4.5 px-1 font-sans text-[10px] leading-none text-muted-foreground"
          />
        }
      >
        <Link2 className="size-2.5!" />
      </TooltipTrigger>
      <TooltipContent className="max-w-xs break-all">
        {paths.map((p) => (
          <span key={p} className="mt-0.5 block font-mono">
            {t("acquireLinkSharedWith", { path: p })}
          </span>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * 「未校验」徽标（任务 14 步骤 1）：拿不到校验值时无法判断本地这份是不是远端
 * 当前版本，点击后台补算完整哈希。一组可能有多片本地文件，对 row.localRels
 * 里的每一项各发一次 `POST /api/v1/file-meta/checksum`（裁定 14-a），
 * `Promise.allSettled` 等齐——手放进去、从没走过下载任务的文件是 unverified
 * 最常见的成因，这条路径下 file_meta 里压根没有对应行，该接口会给 404，
 * 不能吞成一条无信息的失败 toast（裁定 14-b）：至少一片 202 就报「已开始」，
 * 全部非 202 才报「没有元信息，去文件页扫描」。
 */
function UnverifiedBadge({ row }: { row: RepoRow }) {
  const t = useTranslations("pages.repos");
  const [busy, setBusy] = useState(false);

  async function onVerify(): Promise<void> {
    if (busy || row.localRels.length === 0) return;
    setBusy(true);
    const results = await Promise.allSettled(
      row.localRels.map((path) =>
        apiFetch("/api/v1/file-meta/checksum", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
        }),
      ),
    );
    setBusy(false);
    const started = results.some((r) => r.status === "fulfilled" && r.value.status === 202);
    if (started) toast.success(t("driftChecksumStarted"));
    else toast.error(t("driftChecksumUnavailable"));
  }

  return (
    <Badge
      variant="outline"
      title={t("driftUnverifiedTooltip")}
      render={
        <button
          type="button"
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            void onVerify();
          }}
        />
      }
      className="gap-1 px-1.5 font-sans text-[10px] leading-none text-muted-foreground"
    >
      {busy ? <Loader2 className="size-3! animate-spin" /> : <CircleHelp className="size-3!" />}
      {t("driftUnverifiedBadge")}
    </Badge>
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
          {/* 任务 14 步骤 1：两者互斥，有更新优先——repo-files-view.ts 的判定
              本就保证 hasUpdate 与 unverified 不会同时为真（hasUpdate 依赖
              anyDifferent，unverified 显式排除了 anyDifferent），这里的
              if/else if 只是把「优先」这句话在渲染层也说一遍，不是新增约束 */}
          {row.hasUpdate ? (
            <Badge
              variant="outline"
              title={t("driftUpdateTooltip")}
              className="gap-1 border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
            >
              <TriangleAlert className="size-3!" />
              {t("driftUpdateBadge")}
            </Badge>
          ) : row.unverified ? (
            <UnverifiedBadge row={row} />
          ) : null}
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
      // 不在这里渲染：stray 行必有「归位」按钮（strayRels 非空即渲染），
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

