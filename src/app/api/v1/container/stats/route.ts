import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getMetricsCollector, getMetricsStore } from "@/server/locators";
import {
  CONTAINER_STAT_METRICS,
  pickLatestSamples,
  STATS_LOOKBACK_MS,
  type ContainerStatsPayload,
} from "@/server/metrics/latest";
import { getRuntimeService } from "@/server/locators";
import { decorateRuntimeStatus } from "@/server/modelsView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/container/stats：监控页指标卡的当前值快照（M3 Task 5）。
 * store.queryRange(now - 60s) 取 dockerStats / health 指标的最近一点
 * （挑选与整形在 metrics/latest.ts 纯函数层），running 补 decorateRuntimeStatus
 * 的 model + displayName（与 logsStream 的 container 元事件同源）。
 *
 * 响应：`{ samples: {metricId: {value, ts}}, running: {model, displayName} | null }`
 * ——窗口内无样本的指标不出键（前端显示 —）。
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  getMetricsCollector(); // 确保采集心跳在跑（幂等单例，与 window 路由一致）
  const queried = getMetricsStore().queryRange(Date.now() - STATS_LOOKBACK_MS);
  const status = await decorateRuntimeStatus(getDb(), getRuntimeService());

  const { samples } = pickLatestSamples(queried, CONTAINER_STAT_METRICS);
  const payload: ContainerStatsPayload = {
    samples,
    running: status.running
      ? { model: status.running.model, displayName: status.running.displayName }
      : null,
  };
  return NextResponse.json(payload);
}
