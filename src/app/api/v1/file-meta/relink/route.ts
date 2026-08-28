import { NextResponse } from "next/server";
import { z } from "zod";
import { ggufPathSchema } from "@/core/schemas";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { FileMetaError, relinkFile } from "@/server/fileMeta";
import { getPanelModelsRoot } from "@/server/locators";
import { maybeAutoSnapshot } from "@/server/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/file-meta/relink：确认重链（设计 §3.4 第 5 步）。
 *
 * body：`{ path: string, candidatePath: string }`——path 是 file_meta 条目的
 * 现有 path，candidatePath 取自 locate 返回的某个候选的 nextValue（自动静默
 * 改写配置是本设计明确拒绝的行为，必须由用户从候选清单里选一个）。
 *
 * 编排全部在 fileMeta.relinkFile：事务内更新引用旧 path 的全部模型配置 +
 * file_meta.path/probe_path。改了模型配置，视同 model.update 同类变更点，
 * 成功后触发一次自动快照。
 */
const bodySchema = z.strictObject({
  path: ggufPathSchema,
  candidatePath: ggufPathSchema,
});

export async function POST(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
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
  const { path, candidatePath } = parsed.data;
  const db = getDb();

  try {
    const entry = relinkFile(db, getPanelModelsRoot(), path, candidatePath);

    db.prepare("INSERT INTO events(ts, kind, message) VALUES (?, ?, ?)").run(
      Date.now(),
      "file_meta.relink",
      `文件重链：${path} → ${candidatePath}`,
    );
    maybeAutoSnapshot(db); // 改了模型配置的 gguf_file/mmproj_file，视同配置变更点

    return NextResponse.json(entry);
  } catch (error) {
    if (error instanceof FileMetaError) {
      const status = error.code === "NOT_FOUND" ? 404 : 400;
      return NextResponse.json({ error: error.message }, { status });
    }
    throw error;
  }
}
