import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getMetricsCollector, getMetricsStore } from "@/server/locators";
import {
  GPU_STAT_METRICS,
  overlayLatestSamples,
  pickLatestSamples,
  STATS_LOOKBACK_MS,
  sumGpuTotals,
  type GpuStatsPayload,
} from "@/server/metrics/latest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/gpu/stats：GPU 指标卡的当前值快照（M3 Task 5，M5 Task 4 三态化）。
 * status 三态透传 nvidia-smi 探测状态：probing（尚未有结论，面板刚重启）/
 * unavailable（探测确认不可用）/ available（可用）。非 available
 * → `{ available: false, status, samples: null }`；前端据 status 决定
 * 探测中保持中立、确认不可用才显示提示条。
 * 可用 → 与 container/stats 同款：queryRange(now - 60s) 取最近点
 * （probe 刚过尚无样本时 samples 为空对象），另附分卡明细（devices）与
 * 显存合计（totals）——两者是"这次运行内的常量"，不进时序，只走这里。
 *
 * 秒级快照覆盖（秒级指标采集 代号 B）：collector.latestFastSamples() 含
 * nvidia 常驻流的最近一拍，与 ring 样本按 ts 取新者（overlayLatestSamples）；
 * 常驻流未开启/尚未产出时自然回退到原有的 5s ring 值。
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const collector = getMetricsCollector(); // 确保采集心跳在跑（幂等单例）
  const status = collector.nvidiaStatus();
  if (status !== "available") {
    return NextResponse.json({
      available: false,
      status,
      samples: null,
      devices: [],
      totals: null,
    } satisfies GpuStatsPayload);
  }

  const queried = getMetricsStore().queryRange(Date.now() - STATS_LOOKBACK_MS);
  const devices = collector.nvidiaDevices();
  const { samples: ringSamples } = pickLatestSamples(queried, GPU_STAT_METRICS);
  return NextResponse.json({
    available: true,
    status: "available",
    devices,
    totals: sumGpuTotals(devices),
    samples: overlayLatestSamples(ringSamples, collector.latestFastSamples(), GPU_STAT_METRICS),
  } satisfies GpuStatsPayload);
}
