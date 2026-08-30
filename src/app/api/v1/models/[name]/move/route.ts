import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/server/auth";
import { NAMESPACE_PATTERN } from "@/core/schemas";
import { getDb } from "@/server/db";
import { getNamespaceService } from "@/server/locators";
import { NamespaceError, namespaceErrorStatus } from "@/server/namespaces";
import { maybeAutoSnapshot } from "@/server/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/models/:name/move（M1 Task 12；阶段 1b B6 改为纯改分组）：
 * 模型改命名空间，绝不动物理文件——跨空间引用由 gguf_file 的目录段表达，
 * 与当前 namespace 值无关。要移动物理文件请走
 * POST /api/v1/models/:name/move-files（body `{ toFolder }`），两个操作
 * 语义彻底切割，服务层同款拆分见 server/namespaces.ts 顶部注释。
 *
 * body：`{ namespace: string }`
 *
 * 成功 200 返回移动后的完整模型行；409 运行中；404 模型不存在；
 * 400 目标空间不存在 / 与当前空间相同 / body 校验失败。
 */

const moveBodySchema = z.strictObject({
  namespace: z.string().regex(NAMESPACE_PATTERN, "namespace 只允许小写字母数字、点、下划线与连字符"),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const { name } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = moveBodySchema.safeParse(body);
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
    const model = await getNamespaceService().moveModel(name, parsed.data.namespace);
    maybeAutoSnapshot(getDb()); // 配置变更点：自动快照（同步写盘毫秒级；失败仅 warn）
    return NextResponse.json(model);
  } catch (error) {
    if (error instanceof NamespaceError) {
      return NextResponse.json(
        { error: error.message },
        { status: namespaceErrorStatus(error.code) },
      );
    }
    throw error;
  }
}
