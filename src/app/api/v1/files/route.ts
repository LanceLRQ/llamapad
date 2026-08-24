import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { deleteFile, FileApiError, getFileRefs } from "@/server/filesApi";
import { getPanelModelsRoot, getRuntimeService } from "@/server/locators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DELETE /api/v1/files：删文件（三层删除语义的第二层，设计 §5.4）。
 *
 * body：`{ path: string, force?: boolean }`（path 相对 panel models 根，
 * 可为 glob 模式——展开后全删）。
 *
 * 编排顺序（route 只做薄壳）：getFileRefs → 当前运行模型 → filesApi.deleteFile，
 * 守卫与状态映射全部在 filesApi：
 * - path 非法 / 逃逸 models 根 → 400
 * - 文件不存在（含 glob 零命中）→ 404
 * - REFERENCED（被引用且未 force）→ 409 `{ error, refs }`（refs 供确认框列出）
 * - LOCKED（运行中模型引用，force 也不放行）→ 423
 * - 成功 → 200 `{ ok: true, deleted: [...] }` + events `file.delete`
 *   （message 含路径与引用处理方式：无引用 / 强制删除）
 */
const deleteBodySchema = z.strictObject({
  path: z.string().min(1, "path 不能为空"),
  force: z.boolean().optional(),
});

/** FileApiError → HTTP 状态码（REFERENCED 附 refs 响应体） */
function errorResponse(error: FileApiError): NextResponse {
  switch (error.code) {
    case "REFERENCED":
      return NextResponse.json(
        { error: "文件被引用", refs: error.refs ?? [] },
        { status: 409 },
      );
    case "LOCKED":
      return NextResponse.json({ error: "运行中模型引用的文件已锁定" }, { status: 423 });
    case "NOT_FOUND":
      return NextResponse.json({ error: error.message }, { status: 404 });
    case "INVALID_PATH":
      return NextResponse.json({ error: error.message }, { status: 400 });
  }
}

export async function DELETE(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const body = await req.json().catch(() => null);
  const parsed = deleteBodySchema.safeParse(body);
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
  const { path: relPath, force = false } = parsed.data;

  const db = getDb();
  const root = getPanelModelsRoot();
  try {
    const refs = getFileRefs(db, root, relPath);
    const runningModel =
      (await getRuntimeService().getRuntimeStatus()).running?.model ?? null;

    const { deleted } = await deleteFile(root, relPath, { refs, runningModel, force });

    db.prepare("INSERT INTO events(ts, kind, message) VALUES (?, ?, ?)").run(
      Date.now(),
      "file.delete",
      `删除文件 ${deleted.join("、")}（${
        refs.length > 0 ? `强制删除，忽略 ${refs.length} 处引用` : "无引用"
      }）`,
    );
    return NextResponse.json({ ok: true, deleted });
  } catch (error) {
    if (error instanceof FileApiError) return errorResponse(error);
    throw error;
  }
}
