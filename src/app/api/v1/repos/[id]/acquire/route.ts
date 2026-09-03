import { randomUUID } from "node:crypto";
import { statSync, type Stats } from "node:fs";
import { NextResponse } from "next/server";
import { z } from "zod";
import type { QuantGroup, RepoFile } from "@/core/quant";
import { SHA256_PATTERN, toDownloadFile } from "@/lib/acquire-match";
import { AcquireGuardError, assertSourceAllowed, isInside, resolveAllowedRealPath } from "@/server/acquireGuard";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import type { DownloadFileInput, EnqueueLocalItem } from "@/server/download/manager";
import { resolveHfOptions } from "@/server/hf/client";
import { getRemoteGroups } from "@/server/hf/repoFiles";
import { getDownloadManager, getPanelModelsRoot } from "@/server/locators";
import { toPanel } from "@/server/pathMaps";
import { getProfile } from "@/server/repoProfiles";
import { getConfiguredScanDirs } from "@/server/scanDirs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/repos/:id/acquire：一次确认的统一提交入口（设计 §8）。
 *
 * 替换原 POST /repos/:id/download（只有档案页一个调用方，直接迁移，不留两个入口）。
 * body 逐行给出用户选的动作；download 之外的动作都要过三道重验：
 * 源确实存在、L1 仍然匹配、路径落在允许范围内。一次确认产生一个 batch，
 * 混合 download 与 local 两类任务，归档按 batch 统一收口。
 *
 * 三道重验对应的原因：扫描结果不入库，用户确认时源路径由前端带回——这些都是
 * 可篡改的输入，服务端必须自己重新验一遍（不能信前端）：
 * 1) 源确实存在且是普通文件（statSync + isFile）
 * 2) L1 仍然匹配（大小与远端声明一致、远端有可用 oid）——扫描到确认之间
 *    可能过了很久，文件可能已经变了
 * 3) 路径落在允许范围内（models 根 ∪ 自定义扫描目录）——防止构造任意
 *    sourceHostPath 读到范围外的文件；范围判定分两道：assertSourceAllowed
 *    做字符串级目录边界判定（挡 `..` 穿越与前缀相似路径），resolveAllowedRealPath
 *    再对 realpath 判一遍（挡范围内的符号链接指向范围外），**并把解析出的规范
 *    路径作为入队的 sourcePath**——不能继续用校验前的原始路径，否则「校验时
 *    符号链接指向范围内、任务在队列里等着执行时链接已被改指向范围外」这个
 *    TOCTOU 窗口会让上面的校验形同虚设（见 acquireGuard.ts 的头注释）
 *
 * 失败一律返回可区分的错误码（400，`file` 标出是哪一项），不糊成笼统的 500：
 * UNKNOWN_FILE / SOURCE_REQUIRED / OUT_OF_SCOPE / NOT_FOUND / MISMATCH，
 * 供前端决定「能不能一键改成下载」还是「路径本身非法，只能重新扫描」。
 */
const itemSchema = z.strictObject({
  file: z.string().min(1),
  action: z.enum(["download", "move", "link", "copy"]),
  /** 宿主机视角绝对路径；action !== "download" 时必填 */
  sourceHostPath: z.string().min(1).optional(),
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
  const batchId = randomUUID();

  const downloads: DownloadFileInput[] = [];
  const locals: EnqueueLocalItem[] = [];

  for (const item of parsed.data.items) {
    const rf = findRemoteFile(remoteGroups, item.file);
    if (!rf) return NextResponse.json({ error: "UNKNOWN_FILE", file: item.file }, { status: 400 });

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

    if (rf.oid === undefined || !SHA256_PATTERN.test(rf.oid) || st.size !== rf.size) {
      // 重验 2：L1 仍匹配——大小对不上，或远端根本没有可比对的 oid（含格式不合法）
      return guardErrorResponse("MISMATCH", item.file, "本地文件与远端声明不一致（大小或内容校验值）");
    }

    locals.push({
      file: item.file,
      sourcePath: realSourcePath, // 落库/入队用已去符号链接化的规范路径，见上方 TOCTOU 注释
      // 走到这里 item.action 必不是 download（上面已 continue），TS 也收窄好了
      action: item.action,
      sameFs: isInside(getPanelModelsRoot(), realSourcePath),
      size: rf.size,
      sha256: rf.oid,
    });
  }

  const manager = getDownloadManager();
  try {
    if (downloads.length > 0) {
      await manager.enqueueDownload({
        files: downloads,
        targetDir: profile.targetDir,
        source: "hf",
        repo: profile.repo,
        repoId: profile.id,
        label: profile.repo,
        batchId,
      });
    }
    if (locals.length > 0) {
      await manager.enqueueLocal({
        items: locals,
        targetDir: profile.targetDir,
        repoId: profile.id,
        label: profile.repo,
        batchId,
      });
    }
  } catch (error) {
    return mapEnqueueError(error);
  }

  return NextResponse.json({ batchId, downloads: downloads.length, locals: locals.length });
}
