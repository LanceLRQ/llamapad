import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getUpstreamMonitor } from "@/server/locators";
import { listUpstreams } from "@/server/repo/upstreams";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/upstreams/probe：对全部启用的上游各激活一次后台探测（限频 15 秒），
 * 立即返回 202，不等结果。API 中转页打开时调用——不可达的上游已停止定时探测，
 * 没有流量时靠这一下才有机会被发现已恢复。结果从 GET /api/v1/upstreams 读。
 */
export async function POST(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const monitor = getUpstreamMonitor();
  for (const upstream of listUpstreams(getDb())) {
    if (upstream.enabled) monitor.activate(upstream.name);
  }
  return new Response(null, { status: 202 });
}
