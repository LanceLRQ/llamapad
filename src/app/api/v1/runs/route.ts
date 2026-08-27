import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getRunsRepo } from "@/server/locators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * GET /api/v1/runs：运行历史列表（U17 T3，milestones/11 §2.5）。
 * 薄壳调 runsRepo.listRuns，倒序由仓储层保证。
 *
 * limit 非法值（非数字/负数/0）一律回落默认值而非报错——这是监控页的
 * 辅助展示接口，不值得因为一个查询参数格式问题就让整块历史区块渲染失败。
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const raw = new URL(req.url).searchParams.get("limit");
  const parsed = raw !== null ? Number(raw) : NaN;
  const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), MAX_LIMIT) : DEFAULT_LIMIT;

  const runs = getRunsRepo().listRuns(limit);
  return NextResponse.json({ runs });
}
