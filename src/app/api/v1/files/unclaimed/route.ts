import { NextResponse } from "next/server";
import { deriveUnclaimed } from "@/lib/unclaimed-view";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
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
 * file_meta 的 path 集合派生 inRepoDir / hasMeta / sharedWith 三个标签
 * （deriveUnclaimed，src/lib/unclaimed-view.ts）。不写库、不算哈希——
 * 补算哈希是用户显式点「补算」时才做的事，不该在一次列表查询里顺带触发。
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const db = getDb();
  const modelsRoot = getPanelModelsRoot();

  const referenced = new Set(buildRefMap(db, modelsRoot).keys());
  const repoDirs = listRepoDirs(db);
  const metaPaths = new Set(
    (db.prepare("SELECT path FROM file_meta").all() as { path: string }[]).map((row) => row.path),
  );

  const files = deriveUnclaimed(scanTree(modelsRoot), referenced, repoDirs, metaPaths);
  return NextResponse.json({ files });
}
