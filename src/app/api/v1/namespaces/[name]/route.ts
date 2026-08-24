import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getNamespaceService } from "@/server/locators";
import { NamespaceError, namespaceErrorStatus } from "@/server/namespaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /api/v1/namespaces/:name（M1 Task 12）：重命名 / 删除，薄壳调服务层。
 *
 * - PATCH：body `{ name: 新名 }` → 200 `{ ok: true }`
 *   409（该空间有运行中模型 / 新名重复）/ 404（源不存在）/ 400（新名非法）
 * - DELETE：其下无模型配置才删（只删 DB 行，磁盘留给文件页）→ 200；
 *   有配置 409（error 文案带模型数）；不存在 404
 */

const renameBodySchema = z.strictObject({
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, "namespace 只允许小写字母数字与连字符"),
});

function errorResponse(error: NamespaceError): NextResponse {
  return NextResponse.json({ error: error.message }, { status: namespaceErrorStatus(error.code) });
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const { name } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = renameBodySchema.safeParse(body);
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
    await getNamespaceService().renameNamespace(name, parsed.data.name);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof NamespaceError) return errorResponse(error);
    throw error;
  }
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const { name } = await ctx.params;
  try {
    getNamespaceService().deleteNamespace(name);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof NamespaceError) return errorResponse(error);
    throw error;
  }
}
