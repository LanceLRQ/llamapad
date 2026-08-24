import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getRuntimeService } from "@/server/locators";
import { createModelRepo } from "@/server/repo/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/models/:name/restart：重启模型（薄壳调 runtimeService.restartModel）。
 *
 * 状态码约定（与 start 路由一致）：
 * - 404：模型不存在（启动前用 repo 显式查库判定）
 * - 422：模型文件缺失（restartModel 内部走 startModel 的文件校验，拒绝重启）
 * - 500：其余失败（docker 适配器异常等）
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const { name } = await ctx.params;
  if (!createModelRepo(getDb()).getModel(name)) {
    return NextResponse.json({ error: `模型不存在: ${name}` }, { status: 404 });
  }

  try {
    const started = await getRuntimeService().restartModel(name);
    return NextResponse.json({ id: started.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("模型文件缺失")) {
      return NextResponse.json({ error: message }, { status: 422 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
