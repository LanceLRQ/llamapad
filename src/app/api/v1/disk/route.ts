import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getDiskUsage } from "@/server/fsScanner";
import { getPanelModelsRoot } from "@/server/locators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/disk：models 树磁盘占用（薄壳调 fsScanner.getDiskUsage）。
 *
 * 响应：`{ totalBytes, usedBytes, perNamespace: [{ namespace, bytes }] }`
 * - usedBytes / perNamespace：scanTree(panelModelsRoot) 逐命名空间求和
 * - totalBytes：statfs 所在文件系统容量；失败（含 models 根不存在）为 null
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const usage = await getDiskUsage(getPanelModelsRoot());
  return NextResponse.json(usage);
}
