import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getPanelModelsRoot, getRuntimeService } from "@/server/locators";
import { decorateModels } from "@/server/modelsView";
import { createModelRepo } from "@/server/repo/models";
import { maybeAutoSnapshot } from "@/server/snapshot";
import { modelSchema } from "@/core/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/models：全部模型列表（装配视图）。
 *
 * 响应结构（M1 Task 7 起，此前为裸数组）：`{ models: ModelView[] }`——
 * 每行含 DB 字段 + status/quant/sizeBytes/fileCount/hostPort
 * （见 src/server/modelsView.ts）。当前无前端消费方（T8 起接入）。
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;
  const models = await decorateModels(getDb(), getRuntimeService(), getPanelModelsRoot());
  return NextResponse.json({ models });
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
    // 配置变更点：自动快照（同步写盘毫秒级；失败仅 warn，见 snapshot.ts）
    maybeAutoSnapshot(getDb());
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    // 命名空间不存在等业务性错误 → 400
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
