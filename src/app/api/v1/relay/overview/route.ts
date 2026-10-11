import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getRuntimeService } from "@/server/locators";
import { buildRelayOverview } from "@/server/relayOverview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/relay/overview：API 中转页的装配数据（与页面服务端渲染同源）。
 *
 * 响应：`{ defaultModel, services }`。services 每项是运行状态视图
 * （见 GET /api/v1/runtime/status 的 models）加上 `isDefault`、`upstreamBase`、`params`。
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;
  return NextResponse.json(await buildRelayOverview(getDb(), getRuntimeService()));
}
