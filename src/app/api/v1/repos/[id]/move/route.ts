import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { FileMoveError } from "@/server/fileMove";
import { FolderError, folderErrorStatus } from "@/server/folders";
import { getPanelModelsRoot, getRuntimeService } from "@/server/locators";
import { moveProfile, RepoProfileError, repoProfileErrorStatus } from "@/server/repoProfiles";
import { maybeAutoSnapshot } from "@/server/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/repos/:id/move：换存放位置，body `{ toBaseDir: string }`。
 * `moveProfile` 内部直接复用 `renameFolder` 搬整个目录，所以除了档案自身的
 * NOT_FOUND/INVALID_NAME，还会原样透出 renameFolder 的 FolderError（目标已
 * 存在 CONFLICT、目录被运行中模型引用 LOCKED）与 moveFiles 的 FileMoveError
 * （目录已搬、引用重写事务失败——与 folders/rename 同款 MOVE_PARTIAL）。
 *
 * 响应 `{ from: string, to: string, renamed: number }`（renamed 是随目录一起
 * 搬动的文件数）。
 */
const moveBodySchema = z.strictObject({
  toBaseDir: z.string(),
});

export async function POST(
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

  const db = getDb();
  try {
    const runningModel = (await getRuntimeService().getRuntimeStatus()).running?.model ?? null;
    const result = moveProfile(
      { db, modelsRoot: getPanelModelsRoot(), runningModel },
      { id: numericId, toBaseDir: parsed.data.toBaseDir },
    );
    maybeAutoSnapshot(db); // 配置变更点：自动快照（同步写盘毫秒级；失败仅 warn）
    db.prepare("INSERT INTO events(ts, kind, message) VALUES (?, ?, ?)").run(
      Date.now(),
      "repo.move",
      `移动仓库档案 ${result.from} → ${result.to}（${result.renamed} 个文件）`,
    );
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof RepoProfileError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: repoProfileErrorStatus(error.code) },
      );
    }
    if (error instanceof FolderError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: folderErrorStatus(error.code) },
      );
    }
    // 目录已 renameSync 成功、引用重写事务却失败：与 POST /api/v1/folders/rename
    // 的 MOVE_PARTIAL 同一形态，见该文件头注释
    if (error instanceof FileMoveError) {
      return NextResponse.json({ error: "MOVE_PARTIAL", message: error.message }, { status: 500 });
    }
    throw error;
  }
}
