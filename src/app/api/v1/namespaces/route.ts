import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getNamespaceService } from "@/server/locators";
import { NamespaceError, namespaceErrorStatus } from "@/server/namespaces";
import { maybeAutoSnapshot } from "@/server/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /api/v1/namespaces（M1 Task 12）：命名空间列表 + 新建，薄壳调
 * namespaces 服务层（getNamespaceService 组装 db / runtime / 两根）。
 *
 * - GET：`{ namespaces: [{ name, createdAt, modelCount, bytes }] }`
 *   （bytes 来自 scanTree，目录未创建为 0；与 GET /api/v1/disk 的
 *   perNamespace 同源）
 * - POST：body `{ name }`；成功 201；zod 校验失败 400（issues 带字段路径，
 *   与 POST /models 同契约）；重复 409
 */

const nameBodySchema = z.strictObject({
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, "namespace 只允许小写字母数字与连字符"),
});

/** NamespaceError → JSON 响应（状态码来自 namespaceErrorStatus，三个命名空间 route 同款） */
function errorResponse(error: NamespaceError): NextResponse {
  return NextResponse.json({ error: error.message }, { status: namespaceErrorStatus(error.code) });
}

export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  return NextResponse.json({ namespaces: getNamespaceService().listOverview() });
}

export async function POST(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const body = await req.json().catch(() => null);
  const parsed = nameBodySchema.safeParse(body);
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
    getNamespaceService().createNamespace(parsed.data.name);
    maybeAutoSnapshot(getDb()); // 配置变更点：自动快照（同步写盘毫秒级；失败仅 warn）
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (error) {
    if (error instanceof NamespaceError) return errorResponse(error);
    throw error;
  }
}
