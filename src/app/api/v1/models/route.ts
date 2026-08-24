import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { createModelRepo } from "@/server/repo/models";
import { modelSchema } from "@/core/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/models：全部模型列表 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;
  return NextResponse.json(createModelRepo(getDb()).listModels());
}

/** POST /api/v1/models：schema 校验失败 400（带字段路径），成功 201 返回入库模型 */
export async function POST(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const body = await req.json().catch(() => null);
  const parsed = modelSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_model",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  try {
    const created = createModelRepo(getDb()).createModel(parsed.data);
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    // 命名空间不存在等业务性错误 → 400
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
