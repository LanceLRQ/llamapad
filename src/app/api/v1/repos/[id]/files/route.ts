import { existsSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { groupRepoFiles, type QuantGroup } from "@/core/quant";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getDownloadManager, getPanelModelsRoot } from "@/server/locators";
import { buildRefMap } from "@/server/filesApi";
import { scanTree } from "@/server/fsScanner";
import { listRepoFiles, resolveHfOptions } from "@/server/hf/client";
import { getProfile } from "@/server/repoProfiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
 *     | { ok: true; groups: QuantGroup[] }        // HF 可达
 *     | { ok: false; message: string }            // HF 不可达，其余字段不受影响
 *   local: Array<{ rel: string; size: number }>   // 档案目录及子目录内已有文件
 *   strays: Array<{ file: string; rel: string }>  // 全盘同名但不在本档案目录内的文件（宽口径，见下）
 *   tasks: Array<{
 *     file: string
 *     status: "pending" | "downloading" | "paused" | "completed" | "failed" | "cancelled"
 *     downloadedBytes: number
 *   }>
 *   configs: Array<{ rel: string; models: string[] }>  // 已有文件里被配置引用的那部分
 * }
 * ```
 * 失败：400 `{ error: "id 非法" }`；404 `{ error: "NOT_FOUND" }`。
 *
 * `strays` 的过滤依赖档案的远端文件名清单才精确，但远端可能不可达 —— 这里
 * 用「不在本档案目录内的同名文件」这个更宽的口径，前端只对**远端清单里
 * 出现过的文件名**显示 stray 提示，远端失败时不显示，降级路径上不会误报。
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
  const local = tree
    .filter((g) => g.folder === profile.targetDir || g.folder.startsWith(`${profile.targetDir}/`))
    .flatMap((g) => g.files.map((f) => ({ rel: f.rel, size: f.size })));

  // 全盘同名文件但不在本档案目录内 → 用户手动移走或手动放置的（设计 D13 兼容层）
  const localNames = new Set(local.map((f) => f.rel.slice(f.rel.lastIndexOf("/") + 1)));
  const strays = tree
    .filter((g) => g.folder !== profile.targetDir && !g.folder.startsWith(`${profile.targetDir}/`))
    .flatMap((g) => g.files)
    .filter((f) => !localNames.has(f.rel.slice(f.rel.lastIndexOf("/") + 1)))
    .map((f) => ({ file: f.rel.slice(f.rel.lastIndexOf("/") + 1), rel: f.rel }));

  const tasks = getDownloadManager()
    .listTasks()
    .filter((t) => t.repoId === id)
    .map((t) => ({ file: t.file, status: t.status, downloadedBytes: t.downloadedBytes }));

  const refMap = buildRefMap(db, root);
  const configs = local
    .map((f) => ({ rel: f.rel, models: (refMap.get(f.rel) ?? []).map((r) => r.modelName) }))
    .filter((c) => c.models.length > 0);

  let remote: { ok: true; groups: QuantGroup[] } | { ok: false; message: string };
  try {
    const files = await listRepoFiles(profile.repo, await resolveHfOptions());
    remote = { ok: true, groups: groupRepoFiles(files) };
  } catch (error) {
    remote = { ok: false, message: error instanceof Error ? error.message : "远端清单获取失败" };
  }

  return NextResponse.json({
    ...profile,
    dirExists: existsSync(join(root, profile.targetDir)),
    remote,
    local,
    strays,
    tasks,
    configs,
  });
}
