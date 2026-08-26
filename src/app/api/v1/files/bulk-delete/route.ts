import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { bulkDeleteFiles, FileApiError } from "@/server/filesApi";
import { getPanelModelsRoot, getRuntimeService } from "@/server/locators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/files/bulk-delete：批量删文件（U21，files-table.tsx 多选操作条）。
 *
 * 不用 DELETE：body 语义在 DELETE 方法上各代理支持不一，批量场景改用 POST。
 * body：`{ paths: string[], force?: boolean }`（1–200 项，相对 panel models 根）。
 *
 * 编排全部在 filesApi.bulkDeleteFiles（逐个走 getFileRefs + deleteFile）：
 * - LOCKED（运行中模型引用，force 也不放行）/ REFERENCED（未 force）/
 *   NOT_FOUND 归入响应体 skipped，不中断整批
 * - path 非法（含 .. / 绝对路径 / 逃逸 models 根）→ 400，整批不生效
 * 成功 → 200 `{ deleted, skipped }`；有删除项时写一条汇总事件 `file.delete`
 * （"批量删除 N 个文件"，不是逐个写 N 条）。
 */
const bulkDeleteBodySchema = z.strictObject({
  paths: z.array(z.string().min(1, "path 不能为空")).min(1, "paths 不能为空").max(200, "单次最多 200 项"),
  force: z.boolean().optional(),
});

export async function POST(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const body = await req.json().catch(() => null);
  const parsed = bulkDeleteBodySchema.safeParse(body);
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
  const { paths, force = false } = parsed.data;

  const db = getDb();
  const root = getPanelModelsRoot();
  try {
    const runningModel = (await getRuntimeService().getRuntimeStatus()).running?.model ?? null;
    const result = await bulkDeleteFiles(db, root, paths, { runningModel, force });

    if (result.deleted.length > 0) {
      db.prepare("INSERT INTO events(ts, kind, message) VALUES (?, ?, ?)").run(
        Date.now(),
        "file.delete",
        `批量删除 ${result.deleted.length} 个文件`,
      );
    }
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof FileApiError && error.code === "INVALID_PATH") {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
