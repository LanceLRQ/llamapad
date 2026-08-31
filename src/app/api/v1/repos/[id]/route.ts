import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getPanelModelsRoot, getRuntimeService } from "@/server/locators";
import { deleteProfile, RepoProfileError, repoProfileErrorStatus } from "@/server/repoProfiles";
import { maybeAutoSnapshot } from "@/server/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DELETE /api/v1/repos/:id：删除档案，body `{ deleteFiles?: boolean }`（省略
 * 或省略请求体一律按 false 处理，只解除管理关系、目录降级为普通文件夹；
 * true 才递归删掉整个目录，三层语义见 repoProfiles.deleteProfile 头注释）。
 *
 * 响应 `{ targetDir: string, filesDeleted: boolean }`；404/423/400 见
 * repoProfileErrorStatus。
 */
const deleteBodySchema = z.strictObject({
  deleteFiles: z.boolean().default(false),
});

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const { id } = await ctx.params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  // DELETE 请求常常不带 body（纯按 id 删且默认 deleteFiles=false）：空 body
  // 与不存在 body 都归一到 {}，交给 zod 的 .default(false) 兜底，而不是当成
  // "请求体非法" 拒绝——那会让"最常见的调用方式"反而报 400。
  const body = await req.json().catch(() => ({}));
  const parsed = deleteBodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const db = getDb();
  try {
    const runningModel = (await getRuntimeService().getRuntimeStatus()).running?.model ?? null;
    const result = deleteProfile(
      { db, modelsRoot: getPanelModelsRoot(), runningModel },
      { id: numericId, deleteFiles: parsed.data.deleteFiles },
    );
    maybeAutoSnapshot(db); // 配置变更点：自动快照（同步写盘毫秒级；失败仅 warn）
    db.prepare("INSERT INTO events(ts, kind, message) VALUES (?, ?, ?)").run(
      Date.now(),
      "repo.delete",
      `删除仓库档案 ${result.targetDir}` +
        (result.filesDeleted ? "（含磁盘文件）" : "（保留磁盘文件）"),
    );
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof RepoProfileError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: repoProfileErrorStatus(error.code) },
      );
    }
    throw error;
  }
}
