import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getRuntimeService } from "@/server/locators";
import { DEFAULT_DRAIN_TIMEOUT_MS } from "@/server/runtime";
import { createModelRepo } from "@/server/repo/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/models/:name/stop：停止模型（薄壳调 runtimeService.stopModel）。
 *
 * 状态码约定（与 start 路由一致）：
 * - 404：模型不存在；500：其余失败（stopModel 对无容器幂等成功，不额外报错）
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
    const drain = await getRuntimeService().stopModel(name, parsed.data);
    return NextResponse.json(drain ? { ok: true, drain } : { ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
