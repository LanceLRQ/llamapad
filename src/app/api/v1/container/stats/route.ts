import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getMetricsCollector, getMetricsStore } from "@/server/locators";
import {
  CONTAINER_STAT_METRICS,
  overlayLatestSamples,
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
 * 响应：`{ samples: {metricId: {value, ts}}, running: {model, displayName} | null,
 * cpuCount: number | null }`——窗口内无样本的指标不出键（前端显示 —），
 * cpuCount 是 CPU% 的分母（未采集到 → null），不进时序，只走这里。
 *
 * 秒级快照覆盖（秒级指标采集 代号 B）：collector.latestFastSamples() 是
 * 容器 followStats 订阅维护的"最近一帧"，与 ring 样本按 ts 取新者
 * （overlayLatestSamples），有秒级数据时当前值能到 1s 刷新，无秒级数据
 * （尚未收到帧）时自然回退到原有的 5s ring 值，不改变既有降级语义。
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const collector = getMetricsCollector(); // 确保采集心跳在跑（幂等单例，与 window 路由一致）
  const queried = getMetricsStore().queryRange(Date.now() - STATS_LOOKBACK_MS);
  const status = await decorateRuntimeStatus(getDb(), getRuntimeService());

  const { samples: ringSamples } = pickLatestSamples(queried, CONTAINER_STAT_METRICS);
  const samples = overlayLatestSamples(ringSamples, collector.latestFastSamples(), CONTAINER_STAT_METRICS);
  const payload: ContainerStatsPayload = {
    samples,
    running: status.running
      ? { model: status.running.model, displayName: status.running.displayName }
      : null,
    cpuCount: collector.lastCpuCount(),
  };
  return NextResponse.json(payload);
}
