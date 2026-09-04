import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { NextResponse } from "next/server";
import type { QuantGroup } from "@/core/quant";
import { compareToRemote, type DriftState } from "@/lib/version-drift";
import { scanRepoFiles } from "@/lib/repo-files-scan";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getDownloadManager, getPanelModelsRoot, getRuntimeService } from "@/server/locators";
import { listFileMetaRows } from "@/server/fileMeta";
import { buildRefMap } from "@/server/filesApi";
import { scanTree } from "@/server/fsScanner";
import { resolveHfOptions } from "@/server/hf/client";
import { getRemoteGroups } from "@/server/hf/repoFiles";
import { resolveLocalOid, type CachedFullSha256 } from "@/server/localOid";
import { getProfile, listProfiles } from "@/server/repoProfiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RemoteResult =
  | { ok: true; groups: QuantGroup[]; fetchedAt: number; stale: boolean; error: string | null }
  | { ok: false; message: string };

/**
 * GET /api/v1/repos/:id/files：档案详情数据源。
 *
 * 合并四路：远端量化清单（HF）、本地已有文件（扫盘）、进行中的下载任务、
 * 每个文件被哪些配置引用。远端不可达时 `remote.ok = false` 但其余字段照常
 * 返回 —— 国内网络下 HF 超时是常态，此时用户仍需要看到本地已有什么、
 * 仍需要能建配置，不能白屏（设计 D18）。
 *
 * 成功 200，响应字段形状：
 * ```
 * {
 *   id: number
 *   repo: string
 *   baseDir: string
 *   targetDir: string
 *   createdAt: number
 *   dirExists: boolean   // 档案目录在磁盘上是否存在
 *   remote:
 *     | { ok: true; groups: QuantGroup[]; fetchedAt: number; stale: boolean; error: string | null }
 *     | { ok: false; message: string }            // 从没成功取过（无缓存又拉取失败）
 *   // remote.ok 只要拿得到 groups（哪怕是缓存里的旧数据）就是 true；stale 标记
 *   // 这份数据是否已过 TTL，error 标记「这次刷新是否失败」——两者独立：过期但
 *   // 刷新成功 → stale:false error:null；过期且刷新失败 → 旧数据 + stale:true +
 *   // error 非空。远端清单缓存 24 小时（`PANEL_REPO_CACHE_TTL_HOURS` 可覆盖，
 *   // 0 = 只手动刷新），`?refresh=1` 绕过缓存强制重取，见 hf/repoFiles.ts
 *   local: Array<{ rel: string; size: number; sharedWith: string[]; drift?: "same" | "different" | "unknown" }>
 *   // 档案目录及子目录内已有文件（不含 .part 半成品）；sharedWith 是全盘与该
 *   // 文件同 inode（硬链接）的其他路径，数据来自 fsScanner.ModelFile.ino
 *   // （任务 15，设计 §9.1 共用标注），没有共用文件时为空数组。drift 是本地
 *   // 这份与远端当前版本的关系（compareToRemote，规格 §5.1），按 basename
 *   // 找到对应远端文件后算出；远端不可达（remote.ok === false）时不参与
 *   // 计算，字段整个不出现（不是 "unknown"——没有基准不该假装判过）
 *   strays: Array<{               // 全盘同名但不在本档案目录内的文件（宽口径，见下）
 *     file: string
 *     rel: string
 *     size: number
 *     inRepoDir: string | null    // 落在别的档案目录内则是该目录，否则 null（任务 11 起）
 *     drift?: "same" | "different" | "unknown"  // 语义同 local[].drift，供手动关联展示「版本不符」
 *   }>
 *   tasks: Array<{
 *     file: string   // basename，与 local[].rel / strays[].file 同口径（见下方 GET 实现处注释）
 *     status: "pending" | "downloading" | "paused" | "completed" | "failed" | "cancelled"
 *     downloadedBytes: number
 *   }>
 *   configs: Array<{ rel: string; models: string[] }>  // 已有文件里被配置引用的那部分
 *   lockedRels: string[]  // 当前运行中模型引用的文件（models 根相对路径，任务 15）。
 *   // 空数组表示没有模型在跑——「更新到最新版」靠它判断是否要禁用：llama.cpp 是
 *   // mmap 读的，就地覆盖会让正在跑的推理读到半新半旧的字节
 * }
 * ```
 * 失败：400 `{ error: "id 非法" }`；404 `{ error: "NOT_FOUND" }`。
 *
 * `strays` 的过滤依赖档案的远端文件名清单才精确，但远端可能不可达 —— 这里
 * 用「不在本档案目录内的同名文件」这个更宽的口径（见 `lib/repo-files-scan.ts`），
 * 别的档案目录内的同名文件也算候选、并标出 `inRepoDir`（任务 11 起，供硬链接
 * 场景使用）。前端只对**远端清单里出现过的文件名、且大小与远端声明一致**的
 * 才显示 stray 提示（`lib/repo-files-view.ts` 的 I4 裁定），远端失败时不显示，
 * 降级路径上不会误报。
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "id 非法" }, { status: 400 });

  const db = getDb();
  const profile = getProfile(db, id);
  if (profile === null) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const root = getPanelModelsRoot();
  const tree = scanTree(root);
  // strays 只排除本档案目录，别的档案目录内的同名文件标出 inRepoDir：
  // 见 scanRepoFiles 头注释（任务 11 起，I3 时代"整体排除"的口径已超越）
  const repoDirs = listProfiles(db).map((p) => p.targetDir);
  const { local, strays } = scanRepoFiles(tree, profile.targetDir, repoDirs);

  // download_tasks.file 存的是仓库内完整相对路径（unsloth 类仓库形如
  // "UD-Q4_K_XL/model-00001-of-00002.gguf"），而消费端 lib/repo-files-view.ts
  // 的三路匹配（group.files[].path / local[].rel / strays[].file/tasks[].file）
  // 统一按 basename 立契约——这里出口前转成 basename 才能对齐，否则带子目录
  // 的仓库正在下载的量化恒 miss，被误判为「未下载」（缺陷 3）
  const tasks = getDownloadManager()
    .listTasks()
    .filter((t) => t.repoId === id)
    .map((t) => ({ file: basename(t.file), status: t.status, downloadedBytes: t.downloadedBytes }));

  const refMap = buildRefMap(db, root);
  const configs = local
    .map((f) => ({ rel: f.rel, models: (refMap.get(f.rel) ?? []).map((r) => r.modelName) }))
    .filter((c) => c.models.length > 0);

  // 任务 15：当前运行中模型引用的文件集合，供前端「更新到最新版」判定是否要
  // 禁用。取数与 files/move/route.ts:64 同一条既有口径，不重新发明；refMap 已经
  // 展开过 glob（buildRefMap 头注释），这里直接按 modelName 过滤即可，不必再跑
  // 一次 resolveModelFiles
  //
  // 复核 F-4：这条路由此前完全不碰 docker，是纯读盘 + 读 HF 缓存的只读接口；
  // getRuntimeStatus() 走 docker.sock，daemon 重启/权限丢失时会抛错——若不接住，
  // 这个此前"永远能用"的接口会突然让整个档案详情页从"能用"变成错误块（本项目
  // 吃过同类亏：Webhook 页 crypto.randomUUID 抛错被 Next 错误页吞掉全部信息，
  // 一度被误判成功能没开发）。降级为拿不到就当没有运行中模型（lockedRels 恒
  // 空数组）：acquire 路由目前没有独立的运行中占用检查，lockedRels 是这道锁
  // 唯一的防线，这个窗口期间确实会出现「按钮该禁没禁」——但两害相权，让整页
  // 打不开去防一个本就依赖 docker 可达才成立的窄窗口风险，得不偿失，与「远端
  // 不可达时退化成本地视图、不许白屏」（见文件头注释）同一条既定原则
  let runningModel: string | null;
  try {
    runningModel = (await getRuntimeService().getRuntimeStatus()).running?.model ?? null;
  } catch {
    runningModel = null;
  }
  const lockedRels =
    runningModel === null
      ? []
      : [...refMap.entries()]
          .filter(([, refs]) => refs.some((r) => r.modelName === runningModel))
          .map(([rel]) => rel);

  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  const remoteResult = await getRemoteGroups(db, profile.repo, { hf: await resolveHfOptions(), refresh });
  const remote: RemoteResult =
    remoteResult.groups === null
      ? { ok: false, message: remoteResult.error ?? "远端清单获取失败" }
      : {
          ok: true,
          groups: remoteResult.groups,
          fetchedAt: remoteResult.fetchedAt,
          stale: remoteResult.stale,
          error: remoteResult.error,
        };

  // drift 只在远端清单可用时算——没有基准就不假装能判（与 strays 宽口径「远端
  // 失败时不显示」同一条理由，见文件头注释）。local[]/strays[] 都按 basename
  // 找对应的远端文件，三路匹配统一按 basename 立契约的既有口径不变
  let localWithDrift: Array<(typeof local)[number] & { drift?: DriftState }> = local;
  let straysWithDrift: Array<(typeof strays)[number] & { drift?: DriftState }> = strays;
  if (remoteResult.groups !== null) {
    const remoteFileByName = new Map<string, { size: number; oid?: string }>();
    for (const g of remoteResult.groups) {
      for (const f of g.files) {
        if (!remoteFileByName.has(basename(f.path))) {
          remoteFileByName.set(basename(f.path), { size: f.size, oid: f.oid });
        }
      }
    }
    // 优先取 file_meta 缓存的完整 sha256，其次落到 hf CLI 下载边车（真机上
    // 绝大多数既有权重是用 hf CLI 下的，download_tasks 里没有这份记录），
    // 都没有就是 null——resolveLocalOid 本身不做任何哈希计算（零哈希硬约束）
    const metaByRel = new Map(
      listFileMetaRows(db).map((r): [string, CachedFullSha256 | null] => [
        r.path,
        r.fullSha256 === null ? null : { fullSha256: r.fullSha256, size: r.size, mtime: r.mtime },
      ]),
    );
    const withDrift = <T extends { rel: string; size: number }>(f: T): T & { drift?: DriftState } => {
      const remoteFile = remoteFileByName.get(basename(f.rel));
      if (remoteFile === undefined) return f;
      const oid = resolveLocalOid(join(root, f.rel), metaByRel.get(f.rel) ?? null);
      return { ...f, drift: compareToRemote({ size: f.size, oid }, remoteFile) };
    };
    localWithDrift = local.map(withDrift);
    straysWithDrift = strays.map(withDrift);
  }

  return NextResponse.json({
    ...profile,
    dirExists: existsSync(join(root, profile.targetDir)),
    remote,
    local: localWithDrift,
    strays: straysWithDrift,
    tasks,
    configs,
    lockedRels,
  });
}
