import { randomUUID } from "node:crypto";
import { existsSync, statSync, type Stats } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import type { QuantGroup, RepoFile } from "@/core/quant";
import { toDownloadFile, type CandidateLocation } from "@/lib/acquire-match";
import { compareToRemote } from "@/lib/version-drift";
import {
  AcquireGuardError,
  assertActionAllowed,
  assertManualSourceAllowed,
  assertNoGlobRefOnSource,
  assertRemoteMatch,
  assertSourceAllowed,
  describeGlobExtension,
  globExtensionRefs,
  GLOB_EXTENSION_EVENT,
  modelsRelOf,
  resolveAllowedRealPath,
} from "@/server/acquireGuard";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import type { DownloadFileInput, EnqueueLocalItem } from "@/server/download/manager";
import { recordEvent } from "@/server/events";
import { listFileMetaRows } from "@/server/fileMeta";
import { buildRefMap, listModelRefFields, type ModelRefField } from "@/server/filesApi";
import { resolveHfOptions } from "@/server/hf/client";
import { getRemoteGroups } from "@/server/hf/repoFiles";
import { getDownloadManager, getPanelModelsRoot } from "@/server/locators";
import { resolveLocalOid, type CachedFullSha256 } from "@/server/localOid";
import { toPanel } from "@/server/pathMaps";
import { listRepoDirs } from "@/server/repoDirs";
import { getProfile } from "@/server/repoProfiles";
import { getConfiguredScanDirs } from "@/server/scanDirs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/repos/:id/acquire：一次确认的统一提交入口（设计 §8）。
 *
 * 替换原 POST /repos/:id/download（只有档案页一个调用方，直接迁移，不留两个入口）。
 * body 逐行给出用户选的动作；download 之外的动作都要过四道重验：
 * 源确实存在、L1 仍然匹配、路径落在允许范围内、这个位置允许这个动作。
 * 一次确认产生一个 batch，混合 download 与 local 两类任务，归档按 batch 统一收口。
 *
 * 四道重验对应的原因：扫描结果不入库，用户确认时源路径由前端带回——这些都是
 * 可篡改的输入，服务端必须自己重新验一遍（不能信前端）：
 * 1) 源确实存在且是普通文件（statSync + isFile）
 * 2) L1 仍然匹配（`assertRemoteMatch`：源与远端条目成对、远端有可用 oid、大小
 *    与远端声明一致）——扫描到确认之间可能过了很久，文件可能已经变了；配对那
 *    一半与扫描侧共用 `pairsWithRemote`，否则客户端可以把任意同尺寸文件塞给
 *    任意远端条目
 * 3) 路径落在允许范围内（models 根 ∪ 自定义扫描目录）——防止构造任意
 *    sourceHostPath 读到范围外的文件；范围判定分两道：assertSourceAllowed
 *    做字符串级目录边界判定（挡 `..` 穿越与前缀相似路径），resolveAllowedRealPath
 *    再对 realpath 判一遍（挡范围内的符号链接指向范围外），**并把解析出的规范
 *    路径作为入队的 sourcePath**——不能继续用校验前的原始路径，否则「校验时
 *    符号链接指向范围内、任务在队列里等着执行时链接已被改指向范围外」这个
 *    TOCTOU 窗口会让上面的校验形同虚设（见 acquireGuard.ts 的头注释）
 * 4) 这个位置允许这个动作（`assertActionAllowed` 用实测位置复算设计 §4.3 的
 *    动作矩阵）——前三道只问「源能不能读」，不问「能对它做什么」。少了这道，
 *    构造 `{action:"move", sourceHostPath:<别的档案里的文件>}` 就能把文件从
 *    那个档案搬走，且不走 fileMove 的事务重写，留下一堆悬空引用。
 *    矩阵吃的三维事实全部由本路由现场实测，一条都不取自请求体：位置由
 *    realSourcePath 算，版本关系（drift）由实测 size + `resolveLocalOid` 的
 *    本地 oid 比对远端声明得出，引用状态（referenced）现查 `buildRefMap`
 *
 * 落盘前还有一道 glob 预检（审查 I-2 / I-4），因为此刻物理文件**还在原处**：
 * - 源侧：被某条分片 glob 覆盖的文件不许走 move-with-refs（`assertNoGlobRefOnSource`）。
 *   refRewrite.ts 里的同一道拒绝跑在完成回调里，那时 rename 已经做完，分片先被
 *   搬走再报错，正是规格要避免的那件事；那一道保留，作为第二层防御
 * - 目标侧：本次落盘若会被某条既有 glob 收进去，说明另一个模型的文件集合被这次
 *   操作改写了（实测复现过 2 片变 3 片、事件表零提示）。这是合法操作，不拒绝，
 *   但记一条 `acquire.glob_extension` 事件留痕。该洞对 download/copy/link/move
 *   一字不差地成立，所以**所有动作**都过这道检测
 *
 * 手动关联（`manual: true`，规格 §7）放宽的只有「内容与远端声明相符」这一类
 * 证据：跳过第二道重验（含配对——§7.1 明确要求能关联不同名的文件）、drift 不
 * 参与约束、入队 sha256 置空让执行器只算不比。**其余一条都不放宽**，而且每条
 * 服务端都自己算：路径范围两道、源必须是普通文件、动作矩阵、符号链接解析照旧，
 * 额外还加两条位置硬约束（`assertManualSourceAllowed`）——源必须在 models 根内、
 * 且必须未归档。出处是规格 §7.2「**models 根内**的**全部未归档文件**」（两个条件）
 * 与 §8 安全边界表里「路径落在 models 根内」那一行对手动关联写的「保留」；两条都用
 * 实测出来的 location 判，不依赖前端只把根内未归档文件列进弹层。
 *
 * 失败一律返回可区分的错误码（400，`file` 标出是哪一项），不糊成笼统的 500：
 * UNKNOWN_FILE / SOURCE_REQUIRED / OUT_OF_SCOPE / NOT_FOUND / MISMATCH /
 * ACTION_NOT_ALLOWED，供前端决定「能不能一键改成下载」还是「路径本身非法，
 * 只能重新扫描」。其中 ACTION_NOT_ALLOWED 现在有四种成因：位置不允许该动作、
 * 手动关联指向了 models 根外的源、手动关联指向了档案目录内的源、move-with-refs
 * 的源被分片 glob 覆盖。
 */
const itemSchema = z.strictObject({
  file: z.string().min(1),
  action: z.enum(["download", "move", "move-with-refs", "link", "copy"]),
  /** 宿主机视角绝对路径；action !== "download" 时必填 */
  sourceHostPath: z.string().min(1).optional(),
  /** 手动关联（规格 §7）：用户已声明这份文件就是这个远端条目，跳过 L1/L2 的
   *  内容校验。放宽的只有这一条——路径范围（含「必须在 models 根内」）、档案
   *  归属、动作矩阵全部照旧且服务端自算 */
  manual: z.literal(true).optional(),
});
const bodySchema = z.strictObject({ items: z.array(itemSchema).min(1) });

/** remote.groups 里按 path 精确匹配一个文件；item.file 与 RepoFile.path 同口径
 *  （见 lib/acquire-match.ts 的 toDownloadFile：file 字段就是取自 path） */
function findRemoteFile(groups: QuantGroup[], file: string): RepoFile | undefined {
  for (const g of groups) {
    const hit = g.files.find((f) => f.path === file);
    if (hit) return hit;
  }
  return undefined;
}

/** statSync 失败（不存在/无权限等）一律当「不存在」处理，调用方无需分辨具体 errno */
function tryStat(p: string): Stats | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

function guardErrorResponse(code: AcquireGuardError["code"], file: string, message: string): Response {
  return NextResponse.json({ error: code, file, message }, { status: 400 });
}

/** enqueueDownload/enqueueLocal 的同步抛错按消息关键字映射状态码，
 *  与原 download/route.ts 的既有约定一致（409 冲突 / 507 磁盘不足 / 400 非法） */
function mapEnqueueError(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("已有未完成的下载任务")) return NextResponse.json({ error: message }, { status: 409 });
  if (message.includes("磁盘空间不足")) return NextResponse.json({ error: message }, { status: 507 });
  if (message.includes("非法")) return NextResponse.json({ error: message }, { status: 400 });
  return NextResponse.json({ error: message }, { status: 500 });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "id 非法" }, { status: 400 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const db = getDb();
  const profile = getProfile(db, id);
  if (!profile) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const remoteResult = await getRemoteGroups(db, profile.repo, { hf: await resolveHfOptions() }); // 复用档案页那条取数
  if (remoteResult.groups === null) {
    // 从没成功取过远端清单（无缓存又拉取失败）：连 L1 重验的比对基准都没有，
    // 与「文件不在清单里」是两种性质不同的失败——前者是暂时性的、后者是请求本身有问题
    return NextResponse.json(
      { error: "REMOTE_UNAVAILABLE", message: remoteResult.error ?? "远端清单获取失败" },
      { status: 502 },
    );
  }
  const remoteGroups = remoteResult.groups;

  // 自定义扫描目录换算失败（不在任何已知挂载映射内）静默跳过而不是让整个请求
  // 500——一条配置陈旧/失效的目录不该拖垮所有档案的 acquire（对齐 scanDirs 那边
  // 「不可达就报 unreachable、不算错误」的容错取向，只是这里没有渠道回传
  // unreachable 清单，直接从允许范围里去掉即可，效果等价：反正它进不了范围）
  const allowedRoots = [
    getPanelModelsRoot(),
    ...getConfiguredScanDirs(db).flatMap((d) => {
      try {
        return [toPanel(d)];
      } catch {
        return [];
      }
    }),
  ];
  // 档案目录清单：动作矩阵重验要靠它判定源落在哪个档案内，整轮循环只查一次
  const repoDirs = listRepoDirs(db);
  const batchId = randomUUID();
  const modelsRoot = getPanelModelsRoot();
  // 下面三份都是整轮循环只取一次的服务端事实（引用表 / 配置原始值 / 哈希缓存），
  // 全部现查，不接受请求体里的任何对应字段
  const refMap = buildRefMap(db, modelsRoot);
  const refFields = listModelRefFields(db);
  const metaByRel = new Map(
    listFileMetaRows(db).map((r): [string, CachedFullSha256 | null] => [
      r.path,
      r.fullSha256 === null ? null : { fullSha256: r.fullSha256, size: r.size, mtime: r.mtime },
    ]),
  );
  // 与 manager.enqueueDownload / enqueueLocal 内部的 targetRelOf 同一口径
  // （targetDir 为空时落点就是 file 本身）；这里只用于目标侧 glob 扩组检测
  const targetRelOf = (file: string): string =>
    profile.targetDir === "" ? file : `${profile.targetDir}/${file}`;

  const downloads: DownloadFileInput[] = [];
  const locals: EnqueueLocalItem[] = [];
  /** 目标侧 glob 扩组的待记事件：先收集，入队真的成立之后再落库 */
  const globExtensions: { targetRel: string; refs: ModelRefField[] }[] = [];

  for (const item of parsed.data.items) {
    const rf = findRemoteFile(remoteGroups, item.file);
    if (!rf) return NextResponse.json({ error: "UNKNOWN_FILE", file: item.file }, { status: 400 });

    // 目标侧 glob 扩组检测：对**所有**动作都做（download 往档案目录里放一个新
    // .gguf 与 move/copy/link 效果完全一样，都会被同目录的 glob 收走）。目标已
    // 经存在时是覆盖或跳过，模型的文件集合不会变大，不算扩组
    const targetRel = targetRelOf(item.file);
    const extensionRefs = globExtensionRefs(
      refFields,
      targetRel,
      existsSync(path.join(modelsRoot, targetRel)),
    );
    if (extensionRefs.length > 0) globExtensions.push({ targetRel, refs: extensionRefs });

    if (item.action === "download") {
      downloads.push(toDownloadFile(rf));
      continue;
    }
    if (item.sourceHostPath === undefined) {
      return NextResponse.json({ error: "SOURCE_REQUIRED", file: item.file }, { status: 400 });
    }

    let sourcePath: string;
    try {
      sourcePath = toPanel(item.sourceHostPath);
    } catch {
      // 宿主机路径不落在任何已知挂载映射内——同样是「越界」，只是发生在
      // 换算这一步而不是 assertSourceAllowed 那一步
      return guardErrorResponse("OUT_OF_SCOPE", item.file, `源路径无法解析为面板路径: ${item.sourceHostPath}`);
    }

    try {
      assertSourceAllowed(sourcePath, allowedRoots); // 重验 3a：字符串级范围（挡 .. 穿越与前缀相似路径）
    } catch (error) {
      if (error instanceof AcquireGuardError) return guardErrorResponse(error.code, item.file, error.message);
      throw error;
    }

    const st = tryStat(sourcePath); // 重验 1：存在
    if (st === null) return guardErrorResponse("NOT_FOUND", item.file, `源文件不存在: ${sourcePath}`);
    if (!st.isFile()) return guardErrorResponse("NOT_FOUND", item.file, `不是普通文件: ${sourcePath}`);

    let realSourcePath: string;
    try {
      // 重验 3b：realpath 级范围（挡范围内符号链接指向范围外）——返回值必须
      // 取代 sourcePath 用于后续入队，否则「验证用 realpath、执行用原路径」
      // 之间留出一个 TOCTOU 窗口：任务在队列里排着的这段时间，符号链接可以被
      // 改指向范围外，执行器按彼时的链接目标解析，前面的校验就形同虚设了
      realSourcePath = resolveAllowedRealPath(sourcePath, allowedRoots);
    } catch (error) {
      if (error instanceof AcquireGuardError) return guardErrorResponse(error.code, item.file, error.message);
      throw error;
    }

    const manual = item.manual === true;
    // models 根内相对路径：引用表与模型配置字段都是这个键，口径与
    // assertActionAllowed 内部的位置判定同一份（modelsRelOf）。根外为 null
    const sourceRel = modelsRelOf(modelsRoot, realSourcePath);
    // 本地 oid 零哈希计算：优先 file_meta 缓存，其次 hf CLI 下载边车，都没有才 null
    const localOid = resolveLocalOid(
      realSourcePath,
      sourceRel === null ? null : (metaByRel.get(sourceRel) ?? null),
    );

    let expectedSha256: string | null;
    try {
      // 重验 2：L1 仍匹配——源与远端条目成对（判据与扫描侧共用），且远端有可用
      // oid、大小一致。排在动作矩阵之前：缺 oid 这类问题说成「不允许此动作」会
      // 指错方向。返回值就是入队要用的期望 sha256（manual 时为 null）
      expectedSha256 = assertRemoteMatch(
        rf,
        { basename: path.basename(realSourcePath), fullSha256: localOid, size: st.size },
        { manual },
      );
    } catch (error) {
      if (error instanceof AcquireGuardError) return guardErrorResponse(error.code, item.file, error.message);
      throw error;
    }

    let location: CandidateLocation;
    try {
      // 重验 4：动作矩阵。位置事实按 realSourcePath 现场实测，与前端共用同一份
      // actionsFor——前端篡改绕不过去（设计 D13）
      location = assertActionAllowed(rf, item.action, {
        modelsRoot,
        realSourcePath,
        repoDirs,
        // manual 时不把版本关系当约束：unknown 的字面含义就是「没有可用于约束的
        // 内容证据」，而这正是手动关联的处境——用户比面板更懂，这一维被显式放宽
        // （规格 §8）。其余两维照旧生效
        drift: manual ? "unknown" : compareToRemote({ size: st.size, oid: localOid }, rf),
        // 服务端自己查引用表，不信前端（规格 §8）。根外文件不可能被配置引用
        // （gguf_file 受 ggufPathSchema 约束必须是根内相对路径），恒为 false
        referenced: sourceRel !== null && refMap.has(sourceRel),
      });
    } catch (error) {
      if (error instanceof AcquireGuardError) return guardErrorResponse(error.code, item.file, error.message);
      throw error;
    }

    // 手动关联的额外硬约束（规格 §7.2 候选范围 + §8 安全边界表）：源必须在
    // models 根内，且必须未归档。两条都用上一步实测出来的 location 判，不依赖
    // 前端只把根内未归档文件列进弹层。常规项不过这道——根外 + copy 是既有合法路径
    if (manual) {
      try {
        assertManualSourceAllowed(location);
      } catch (error) {
        if (error instanceof AcquireGuardError) return guardErrorResponse(error.code, item.file, error.message);
        throw error;
      }
    }

    // 源侧 glob 预检（审查 I-2）：被分片 glob 覆盖的源不许走 move-with-refs。
    // 必须拦在入队之前——refRewrite 的同一道拒绝跑在完成回调里，那时文件已经
    // 搬走，拒绝只剩一条日志。根外的源到不了这里（矩阵不给 move-with-refs），
    // 判 null 只是让类型收敛
    if (item.action === "move-with-refs" && sourceRel !== null) {
      try {
        assertNoGlobRefOnSource(refFields, sourceRel);
      } catch (error) {
        if (error instanceof AcquireGuardError) return guardErrorResponse(error.code, item.file, error.message);
        throw error;
      }
    }

    locals.push({
      file: item.file,
      sourcePath: realSourcePath, // 落库/入队用已去符号链接化的规范路径，见上方 TOCTOU 注释
      // 走到这里 item.action 必不是 download（上面已 continue），TS 也收窄好了
      action: item.action,
      sameFs: location.inModelsRoot, // 上一步实测出来的，不重复算一遍
      // 手动关联的大小必须是**实测值**：执行器按入队时声明的 expectedSize 校验，
      // 沿用远端声明的大小会让手动关联必然因大小不符而失败（放宽的前提就是
      // 大小可能不同）。常规项两者已由 assertRemoteMatch 保证相等
      size: manual ? st.size : rf.size,
      // 不变量（下游依赖，改这里前先看 EnqueueLocalItem.sha256 的注释）：
      // **常规 local 任务的 sha256 必须非空**——manager/localAcquire 用「local
      // 任务且入队时 sha256 为 NULL」当作手动关联的判据，一旦常规项也能给出
      // null，那条推导会静默失效、常规任务被降级成免比对。这里的非空性由
      // assertRemoteMatch 的返回值维持：唯一的 return null 分支就是
      // opts.manual（函数第一行），靠单测与全库唯一调用点共同保证，是运行时
      // 约定而不是类型保证——这里的实参 { manual: item.manual === true } 静态
      // 类型只是 boolean，编译器在这里区分不出两种情形
      sha256: expectedSha256,
    });
  }

  const manager = getDownloadManager();
  const skipped: string[] = [];
  // 两次入队是两次独立的 await，第二次抛错（磁盘预检 507 / 并发占用 409）时第一次
  // 已经真实入队并开跑：客户端只看到「整体失败」不落 batchId，用户重新提交必然撞上
  // 自己刚入队的那批（assertNoUnfinishedAtTargets → 409），除非去下载页手动取消，
  // 否则这个档案再也提交不了。所以任一步抛错都把本批已入队的部分整批撤回
  // （cancelBatch），让这次提交「要么整体成立、要么整体不留痕」
  try {
    if (downloads.length > 0) {
      const res = await manager.enqueueDownload({
        files: downloads,
        targetDir: profile.targetDir,
        source: "hf",
        repo: profile.repo,
        repoId: profile.id,
        label: profile.repo,
        batchId,
      });
      skipped.push(...res.skipped);
    }
    if (locals.length > 0) {
      const res = await manager.enqueueLocal({
        items: locals,
        targetDir: profile.targetDir,
        repoId: profile.id,
        label: profile.repo,
        batchId,
      });
      skipped.push(...res.skipped);
    }
  } catch (error) {
    await manager.cancelBatch(batchId);
    return mapEnqueueError(error);
  }

  // 目标侧 glob 扩组留痕（审查 I-4）：合法操作不拦，但不能静默——另一个模型的
  // 文件集合被这次落盘改写了。记在入队成立之后，免得整批撤回时留下一条并没有
  // 发生过的记录
  for (const ext of globExtensions) {
    recordEvent(db, GLOB_EXTENSION_EVENT, describeGlobExtension(ext.targetRel, ext.refs));
  }

  return NextResponse.json({
    batchId,
    downloads: downloads.length,
    locals: locals.length,
    // 目标已存在而没入队的文件：前端据此把这些文件视同已完成，否则「整组是否
    // 完成」的判定对部分被跳过的组永远不成立（弹层行会卡死在执行中）
    skipped,
  });
}
