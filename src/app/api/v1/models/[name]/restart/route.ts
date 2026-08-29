import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getRuntimeService } from "@/server/locators";
import { DEFAULT_DRAIN_TIMEOUT_MS, RuntimeBusyError } from "@/server/runtime";
import { createModelRepo } from "@/server/repo/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/models/:name/restart：重启模型（薄壳调 runtimeService.restartModel）。
 *
 * 状态码约定（与 start 路由一致）：
 * - 404：模型不存在（启动前用 repo 显式查库判定）
 * - 409：运行时忙（上一个启停请求尚未结束，见 runtime.ts 的 RuntimeBusyError）
 * - 422：模型文件缺失（restartModel 内部走 startModel 的文件校验，拒绝重启）
 * - 500：其余失败（docker 适配器异常等）
 *
 * body（可选，语义同 start 路由）：`{ drain?: boolean, drainTimeoutMs?: number }`。
 */

const bodySchema = z.strictObject({
  drain: z.boolean().optional(),
  drainTimeoutMs: z.number().int().min(1_000).max(600_000).default(DEFAULT_DRAIN_TIMEOUT_MS),
});

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

  const body = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_body",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  try {
    const started = await getRuntimeService().restartModel(name, parsed.data);
    return NextResponse.json(
      started.drain !== undefined ? { id: started.id, drain: started.drain } : { id: started.id },
    );
  } catch (error) {
    if (error instanceof RuntimeBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("模型文件缺失")) {
      return NextResponse.json({ error: message }, { status: 422 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
