import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getMetricsCollector, getRunsRepo } from "@/server/locators";
import { sumGpuTotals } from "@/server/metrics/latest";
import { createModelRepo } from "@/server/repo/models";
import { judgePreflight } from "@/server/runs";
import { mergeConfig } from "@/core/config";
import { visibleDevices } from "@/lib/gpu-visibility";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/models/:name/preflight：启动前显存预警（U17 T3，milestones/11 §2.5）。
 * 只预警不拦截（D2）——判定结果仅供 StartProgressDialog 顶部提示用，
 * 启动本身不受此接口影响。
 *
 * GPU 不可用时 nvidiaDevices() 返回 []，sumGpuTotals 随之返回 null，
 * freeMib/totalMib 为 null，judgePreflight 自然给出 "unknown"——
 * 这里不为该情况写特判分支，让纯函数吃掉。
 *
 * 同一条路径也吃掉「docker.gpu 声明了机器上不存在的卡号」：visibleDevices 返回空、
 * 判定退化为 unknown。这比谎报一个数字好；真正的越界提示由表单的 splitHints 承担，
 * 本接口只预警不拦截（U17 既有定案，milestones/11 §2.5）。
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const { name } = await ctx.params;
  const modelRepo = createModelRepo(getDb());
  const model = modelRepo.getModel(name);
  if (!model) {
    return NextResponse.json({ error: `模型不存在: ${name}` }, { status: 404 });
  }

  const repo = getRunsRepo();
  // 按该模型实际可见的卡求和，而非全机聚合：模型配了 device=0 时，另一张卡的
  // 空闲显存它根本用不上，算进来会让判定虚高（多卡支持批次，设计 §4.2）
  const gpu = mergeConfig(modelRepo.getDefaultConfig(), model.overrides ?? {}).docker.gpu;
  const totals = sumGpuTotals(visibleDevices(getMetricsCollector().nvidiaDevices(), gpu));
  const freeMib = totals !== null ? totals.memTotalMib - totals.memUsedMib : null;
  const totalMib = totals?.memTotalMib ?? null;
  const peakNetMib = repo.peakNetMibFor(name);

  return NextResponse.json({
    verdict: judgePreflight(freeMib, peakNetMib),
    freeMib,
    totalMib,
    peakNetMib,
    runCount: repo.countRunsFor(name),
  });
}
