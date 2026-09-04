import { NextResponse } from "next/server";
import { z } from "zod";
import { actionsFor, matchLocalCandidate, mergeGroupMatch } from "@/lib/acquire-match";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { modelsHostUnresolvedDetail } from "@/server/doctor";
import { listFileMetaRows } from "@/server/fileMeta";
import { buildRefMap } from "@/server/filesApi";
import { resolveHfOptions } from "@/server/hf/client";
import { getRemoteGroups } from "@/server/hf/repoFiles";
import { getPanelModelsRoot } from "@/server/locators";
import { resolveLocalOid } from "@/server/localOid";
import { getDiscoveredMounts } from "@/server/mounts";
import { getModelsHostSource } from "@/server/panelConfig";
import { toHost, toPanel } from "@/server/pathMaps";
import { listRepoDirs } from "@/server/repoDirs";
import { getProfile } from "@/server/repoProfiles";
import { collectScanCandidates } from "@/server/scanCandidates";
import { getConfiguredScanDirs, setConfiguredScanDirs } from "@/server/scanDirs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/repos/:id/scan：深度扫描（设计 §8）。
 *
 * 与进页面时那次自动扫（GET /repos/:id/files 的 local/strays，见 lib/repo-files-scan.ts，
 * 设计 D12）的区别只在范围——这里额外扫用户配置的自定义目录，并对每个候选与本档案
 * 远端量化清单跑一遍 L1 匹配（lib/acquire-match.ts），按组给出可选动作。
 * 结果不入库（用户决策 D2），一次性返回给前端；`extraDirs` 传入时顺带落库成
 * 后续扫描的默认范围，这就是设计 §8 里 `PUT /settings/scan-dirs` 的写入路径
 * （复用本路由，不单独开一条）。**空数组是「清除已配置目录」而不是「沿用旧值」**
 * ——沿用旧值是「不带这个键」的语义；档案页的输入框由已持久化的值回填，
 * 每次扫描都原样发出去，用户清空输入框就是要把范围清掉。
 *
 * 自定义目录不可达时不算错误：candidates 构建（collectScanCandidates）把它们收进
 * unreachable 清单，让前端说清「该路径在面板容器内不可见，需要在 docker-compose.yml
 * 增加挂载」，而不是笼统的「目录不存在」——面板是容器，看不见宿主机大部分路径是常态。
 *
 * 每个候选与远端文件的关系是 same / different / unknown 三值（`DriftState`，
 * lib/version-drift.ts），由 oid（内容 sha256）或 size 判定；oid 经
 * server/localOid.resolveLocalOid 解析，优先取 file_meta 缓存，其次读 hf CLI
 * 下载边车，都没有才是 null——本路由自身不做任何哈希计算。`referenced` 由
 * buildRefMap（server/filesApi.ts）现查，标记该候选是否已被某个模型配置引用。
 * 响应里的 `unarchived` 是候选池里落在 models 根内、不属于任何档案目录的那部分，
 * 供前端手动关联弹层直接取用，不必为它另开一次扫盘。
 *
 * models 宿主机根三级优先链全落空（`getModelsHostSource() === "unresolved"`）时
 * 直接 503 拦下：此时候选的宿主机路径根本换算不出来，扫了也只会在提交阶段
 * 变成一堆完全不指向真因的 OUT_OF_SCOPE（真机上最常见的成因是 docker.sock 的
 * gid 配错导致自动发现失败）。文案与 Doctor 的 pathMap 检查共用一份。
 *
 * 远端清单彻底不可用（从没有成功取过、这次也失败）时整个匹配无从做起——不像
 * acquire 只是校验一个已知条目，scan 需要远端清单本身来告诉候选「应该分几组、
 * 各组该有哪些文件」，没有清单就没有组可言；与 acquire 路由同款处理（502
 * REMOTE_UNAVAILABLE）。绝大多数「远端不可达」场景其实有 24h 缓存兜底
 * （getRemoteGroups 未强制 refresh 时命中缓存不管新旧），这一支只覆盖
 * 「从未成功取过且此刻也连不上」的边界情况。
 */
const bodySchema = z.strictObject({ extraDirs: z.array(z.string().min(1)).optional() });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "id 非法" }, { status: 400 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const db = getDb();
  const profile = getProfile(db, id);
  if (!profile) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  // 落库先于远端可用性判断：用户这次填的自定义目录是独立于远端的配置，
  // 网络恰好不通不该让他白填一遍——哪怕这次扫描本身因远端不可达而失败，
  // 下次点「扫描」时这份目录仍应该是默认范围
  const extraHostDirs = parsed.data.extraDirs ?? getConfiguredScanDirs(db);
  // 判 undefined 而不是判真值：空数组是合法的「清除」意图，不能被当成没传
  if (parsed.data.extraDirs !== undefined) setConfiguredScanDirs(db, parsed.data.extraDirs);

  // models 宿主机根没解析到时整条链路都是坏的：候选的 hostPath 换算不出来
  // （toHost 会抛错），能算出来的也全是垃圾，用户要到提交那一步才收到一堆
  // OUT_OF_SCOPE，而那个报错完全不指向真因。在这里就地拦下并给出 Doctor 同款
  // 排障文案，别让用户先扫一遍再撞墙
  if (getModelsHostSource() === "unresolved") {
    return NextResponse.json(
      { error: "MODELS_HOST_UNRESOLVED", message: modelsHostUnresolvedDetail(getPanelModelsRoot()) },
      { status: 503 },
    );
  }

  const remoteResult = await getRemoteGroups(db, profile.repo, { hf: await resolveHfOptions() });
  if (remoteResult.groups === null) {
    return NextResponse.json(
      { error: "REMOTE_UNAVAILABLE", message: remoteResult.error ?? "远端清单获取失败" },
      { status: 502 },
    );
  }

  const modelsRoot = getPanelModelsRoot();
  const refMap = buildRefMap(db, modelsRoot);
  const metaByRel = new Map(listFileMetaRows(db).map((r) => [r.path, r.fullSha256]));

  const { candidates, unreachable, unarchived } = collectScanCandidates({
    modelsRoot,
    extraHostDirs,
    repoDirs: listRepoDirs(db),
    fullSha256ByRel: metaByRel,
    referencedRels: new Set(refMap.keys()),
    // 缓存值取不到时回落到 hf CLI 边车：真机上绝大多数既有权重是用 hf CLI 下的，
    // download_tasks 里根本没有记录，只靠 file_meta 会让 drift 全是 unknown
    resolveOid: (rel, absPath) => resolveLocalOid(absPath, metaByRel.get(rel) ?? null),
    toHost,
    toPanel,
  });

  // 按组聚合：动作是整组一起执行的，弹层一行 = 一个量化组（设计 §4.4）
  const groups = remoteResult.groups.map((g) => {
    const files = g.files.map((rf) => {
      const hit = matchLocalCandidate(rf, candidates);
      const facts =
        hit === null
          ? null
          : {
              inRepoDir: hit.candidate.inRepoDir,
              inModelsRoot: hit.candidate.inModelsRoot,
              drift: hit.drift,
              referenced: hit.candidate.referenced,
            };
      return {
        file: rf.path,
        candidate: hit?.candidate ?? null,
        drift: hit?.drift ?? null,
        ...actionsFor(rf, facts),
      };
    });
    return mergeGroupMatch(g.quant, g.kind, files);
  });

  return NextResponse.json({
    groups,
    unreachable,
    availableMounts: getDiscoveredMounts(),
    // 手动关联弹层的候选池（规格 §7.2）：models 内全部未归档文件，不限名不限大小
    unarchived,
  });
}
