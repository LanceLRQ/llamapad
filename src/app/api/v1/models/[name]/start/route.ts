import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getRuntimeService } from "@/server/locators";
import { createModelRepo } from "@/server/repo/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/models/:name/start：启动模型（薄壳调 runtimeService.startModel）。
 *
 * 状态码约定：
 * - 404：模型不存在（启动前用 repo 显式查库判定，不依赖错误 message）
 * - 422：模型文件缺失（gguf / 已配置的 mmproj 任一缺失，startModel 拒绝启动）
 * - 500：其余失败（docker 适配器异常等）
 *
 * 422 依据 startModel 抛错的 message 前缀「模型文件缺失」识别——
 * runtime 层的错误契约是中文 message（见 runtime.ts），此处不修改既有模块。
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
    const started = await getRuntimeService().startModel(name);
    return NextResponse.json({ id: started.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("模型文件缺失")) {
      return NextResponse.json({ error: message }, { status: 422 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
