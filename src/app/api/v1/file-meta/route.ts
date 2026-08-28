import { NextResponse } from "next/server";
import { z } from "zod";
import { ggufPathSchema } from "@/core/schemas";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { FileMetaError, listFileMeta, setFileMetaFields } from "@/server/fileMeta";
import { getPanelModelsRoot } from "@/server/locators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /api/v1/file-meta（设计 §3，`docs/_internal/features/
 * 2026-08-28-文件管理与镜像管理-design.md`）
 *
 * - GET：元信息列表。listFileMeta 先对当前全部有效引用幂等登记/刷新一遍，
 *   再整表返回，含孤儿标记（isOrphan）与量化标签（quantLabel 用户值 +
 *   detectedQuant 推断值，前端展示优先级 quantLabel > detectedQuant，
 *   且不应把 detectedQuant 预填进编辑框）。
 * - PUT：编辑 quant_label / mark，字段缺省不改，传 null 显式清空。
 */

const putBodySchema = z.strictObject({
  path: ggufPathSchema,
  quantLabel: z.string().max(64).nullable().optional(),
  mark: z.string().max(500).nullable().optional(),
});

export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const entries = await listFileMeta(getDb(), getPanelModelsRoot());
  return NextResponse.json({ entries });
}

export async function PUT(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const body = await req.json().catch(() => null);
  const parsed = putBodySchema.safeParse(body);
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
  const { path, ...patch } = parsed.data;

  try {
    const entry = setFileMetaFields(getDb(), getPanelModelsRoot(), path, patch);
    return NextResponse.json(entry);
  } catch (error) {
    if (error instanceof FileMetaError && error.code === "NOT_FOUND") {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
}
