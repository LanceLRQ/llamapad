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
 * POST /api/v1/models/:name/move-files（阶段 1b B6）：把模型的物理文件
 * （glob 展开的 gguf 组 + mmproj）移动到目标文件夹，绝不改 namespace——
 * 与 POST /api/v1/models/:name/move（改分组，不动文件）语义彻底切割，
 * 服务层同款拆分见 server/namespaces.ts 顶部注释。
 *
 * body：`{ toFolder: string }`（models 根下的既有一级目录，不自动新建——
 * 防手滑打错路径建出一堆空目录，新建目录留给后续批次）。
 *
 * 成功 200 返回移动后的完整模型行；404 模型不存在；
 * 400 目标目录不存在 / body 校验失败；409 模型自身运行中；
 * 423 与运行中模型共享文件（LOCKED，不能让运行中容器的配置在脚下被改）。
 */
const moveFilesBodySchema = z.strictObject({
  toFolder: z.string().min(1, "toFolder 不能为空"),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const { name } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = moveFilesBodySchema.safeParse(body);
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
    const model = await getNamespaceService().moveModelFiles(name, parsed.data.toFolder);
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
