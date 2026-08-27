import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getMetricsCollector, getMetricsStore } from "@/server/locators";
import {
  HOST_STAT_METRICS,
  overlayLatestSamples,
  pickLatestSamples,
  STATS_LOOKBACK_MS,
  type HostStatsPayload,
} from "@/server/metrics/latest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/host/stats（G4：容器视角之外补宿主机 CPU/内存/负载/磁盘/网络）：
 * 与既有 container/stats·gpu/stats 同款薄壳——鉴权 + 组装，样本挑选与
 * 覆盖合并全在 metrics/latest.ts 纯函数层，本文件不做判断。
 *
 * 响应：`{ samples: {metricId: {value, ts}}, hostCpuCount, hostMemTotalBytes,
 * hostDiskTotalBytes }`——窗口内无样本的指标不出键（前端显示 —），三个分母
 * 是各自指标的"分母"（核数/内存总量/磁盘总量），一次运行内的常量，不进
 * 时序，尚未采到 → null。
 *
 * 秒级快照覆盖：collector.latestFastSamples() 含 hostStats 自带 1s 定时器
 * 产出的最近一帧，与 ring 样本按 ts 取新者（overlayLatestSamples），
 * 与 container/gpu 两个既有路由同一套机制。
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const collector = getMetricsCollector(); // 确保采集心跳在跑（幂等单例，与其余 stats 路由一致）
  const queried = getMetricsStore().queryRange(Date.now() - STATS_LOOKBACK_MS);
  const { samples: ringSamples } = pickLatestSamples(queried, HOST_STAT_METRICS);
  const samples = overlayLatestSamples(ringSamples, collector.latestFastSamples(), HOST_STAT_METRICS);
  const denominators = collector.hostDenominators();

  const payload: HostStatsPayload = {
    samples,
    hostCpuCount: denominators.cpuCount,
    hostMemTotalBytes: denominators.memTotalBytes,
    hostDiskTotalBytes: denominators.diskTotalBytes,
  };
  return NextResponse.json(payload);
}
