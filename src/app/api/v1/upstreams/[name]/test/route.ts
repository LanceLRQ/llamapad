import { NextResponse } from "next/server";

import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getUpstreamMonitor } from "@/server/locators";
import { getUpstream } from "@/server/repo/upstreams";
import { probeUpstream } from "@/server/upstreams/monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/upstreams/:name/test：立即探测一个已登记的上游。
 * 响应 `{ ok, status, latencyMs, models, error }`：ok 表示拿到了 HTTP 响应（服务在线），
 * status 是上游的状态码（401 多半是密钥不对），models 是上游 /v1/models 返回的模型 id。
 *
 * 启用的上游走 monitor.probeNow，结果同时更新存活状态；停用的上游只探测、不记状态。
 */
export async function POST(req: Request, ctx: { params: Promise<{ name: string }> }): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const { name } = await ctx.params;
  const stored = getUpstream(getDb(), name);
  if (stored === null) return NextResponse.json({ error: `上游不存在: ${name}` }, { status: 404 });

  const result =
    (await getUpstreamMonitor().probeNow(name)) ??
    (await probeUpstream({ baseUrl: stored.baseUrl, apiKey: stored.apiKey }));
  return NextResponse.json(result);
}
