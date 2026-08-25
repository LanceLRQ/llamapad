import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getMetricsCollector, getMetricsStore } from "@/server/locators";
import { buildWindowPayload, parseRangeKey, RANGE_DEFS } from "@/server/metrics/window";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/metrics/window?range=30m|2h|24h|7d：概览图表的窗口查询
 * （M3 Task 4）。range 非法 400；from = now - range 交给 store.queryRange
 * 自动降源（ring 5s / 15min 桶）。
 *
 * 响应：`{ range, from, resolution: "5s"|"15m", series: {metricId: [{ts,value}]} }`
 * ——series 恒含全部指标键，未采集者为空数组（前端以空数组判卡片隐藏）。
 *
 * 首次取用顺带 getMetricsCollector()：采集是惰性单例（locators 首次取用
 * 即开跑 5s 心跳），metrics 的任何消费者出现即视为需要采集，无需额外
 * 启动钩子；后续请求命中单例无额外开销。
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const range = parseRangeKey(new URL(req.url).searchParams.get("range"));
  if (range === null) {
    return NextResponse.json({ error: "invalid range" }, { status: 400 });
  }

  getMetricsCollector(); // 确保采集心跳已在跑（幂等单例）
  const from = Date.now() - RANGE_DEFS[range];
  const queried = getMetricsStore().queryRange(from);
  return NextResponse.json(buildWindowPayload(range, from, queried));
}
