import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getMetricsCollector, getMetricsStore } from "@/server/locators";
import {
  GPU_STAT_METRICS,
  pickLatestSamples,
  STATS_LOOKBACK_MS,
  type GpuStatsPayload,
} from "@/server/metrics/latest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/gpu/stats：GPU 指标卡的当前值快照（M3 Task 5）。
 * nvidia 不可用（本机无 NVIDIA / 未 --gpus 部署，启动时 probe 一次定局）
 * → `{ available: false, samples: null }`，前端隐藏两卡并展示提示条；
 * 可用 → 与 container/stats 同款：queryRange(now - 60s) 取最近点
 * （probe 刚过尚无样本时 samples 为空对象）。
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const collector = getMetricsCollector(); // 确保采集心跳在跑（幂等单例）
  if (!collector.isNvidiaAvailable()) {
    return NextResponse.json({ available: false, samples: null } satisfies GpuStatsPayload);
  }

  const queried = getMetricsStore().queryRange(Date.now() - STATS_LOOKBACK_MS);
  return NextResponse.json({
    available: true,
    ...pickLatestSamples(queried, GPU_STAT_METRICS),
  } satisfies GpuStatsPayload);
}
