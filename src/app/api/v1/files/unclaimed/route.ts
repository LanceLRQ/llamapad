import { NextResponse } from "next/server";
import { annotatedFileMetaPaths, deriveUnclaimed } from "@/lib/unclaimed-view";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { listFileMetaRows } from "@/server/fileMeta";
import { buildRefMap } from "@/server/filesApi";
import { scanTree } from "@/server/fsScanner";
import { getPanelModelsRoot } from "@/server/locators";
import { listRepoDirs } from "@/server/repoDirs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/files/unclaimed：全库游离文件清单（设计 §4.1 / §9.3，交付 C）。
 *
 * 只读薄壳：scanTree + buildRefMap 算出 refs===0 的补集，配 listRepoDirs /
 * file_meta 的 quant_label/mark 派生 inRepoDir / hasMeta / sharedWith 三个
 * 标签（deriveUnclaimed，src/lib/unclaimed-view.ts）。不写库、不算哈希——
 * 补算哈希是用户显式点「补算」时才做的事，不该在一次列表查询里顺带触发。
 *
 * hasMeta 取 listFileMetaRows（只读快照）+ annotatedFileMetaPaths 过滤出
 * quant_label/mark 非空的路径（任务 18 复核修的 bug：不能拿"file_meta 有
 * 这一行"当判定条件——游离文件一旦被 listFileMeta 登记过就会有一行，但
 * quant_label/mark 皆为 null，那不是"有备注"）。
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const db = getDb();
  const modelsRoot = getPanelModelsRoot();

  const referenced = new Set(buildRefMap(db, modelsRoot).keys());
  const repoDirs = listRepoDirs(db);
  const annotatedPaths = annotatedFileMetaPaths(listFileMetaRows(db));

  const files = deriveUnclaimed(scanTree(modelsRoot), referenced, repoDirs, annotatedPaths);
  return NextResponse.json({ files });
}
