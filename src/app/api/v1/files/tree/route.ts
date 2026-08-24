import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getFilesTree } from "@/server/filesApi";
import { getPanelModelsRoot } from "@/server/locators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/files/tree：models 文件树 + 每文件引用计数（薄壳调 filesApi）。
 *
 * 响应：`{ tree: [{ namespace, files: [{ rel, size, mtime, refs }] }] }`
 * - tree：scanTree(panelModelsRoot)（命名空间与文件各自排序，隐藏文件跳过）
 * - refs：引用该文件的配置数（精确 + glob 展开，见 filesApi.getFilesTree）
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const tree = getFilesTree(getDb(), getPanelModelsRoot());
  return NextResponse.json({ tree });
}
