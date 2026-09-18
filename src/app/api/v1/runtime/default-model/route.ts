import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getRuntimeService } from "@/server/locators";
import { DefaultModelNotRunningError } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 默认模型（多模型并行，决策 D5）：API 中转请求不带 model 字段时发往它。
 * 进程内状态，不落库；面板重启后按最早启动的在跑模型重建。
 *
 * - GET → `{ defaultModel: string | null, models: string[] }`（models 为运行中的模型名，按启动时间升序）
 * - PUT `{ model: string }` → 200 `{ defaultModel }`；该模型没在运行 → 409；请求体不合法 → 400
 */

const bodySchema = z.strictObject({ model: z.string().min(1) });

export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const status = await getRuntimeService().getRuntimeStatus();
  return NextResponse.json({
    defaultModel: status.defaultModel,
    models: status.models.map((m) => m.model),
  });
}

export async function PUT(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_body",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      },
      { status: 400 },
    );
  }

  try {
    await getRuntimeService().setDefaultModel(parsed.data.model);
  } catch (error) {
    if (error instanceof DefaultModelNotRunningError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
  return NextResponse.json({ defaultModel: parsed.data.model });
}
