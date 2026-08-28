import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { clearOrphans } from "@/server/fileMeta";
import { getPanelModelsRoot } from "@/server/locators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DELETE /api/v1/file-meta/orphans：清理孤儿记录（设计 §3.6，meta 有、磁盘无）。
 * 不级联影响模型配置——孤儿定义纯粹是 file_meta 行自身，与是否还有模型引用无关。
 */
export async function DELETE(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const db = getDb();
  const deleted = clearOrphans(db, getPanelModelsRoot());

  if (deleted > 0) {
    db.prepare("INSERT INTO events(ts, kind, message) VALUES (?, ?, ?)").run(
      Date.now(),
      "file_meta.clear_orphans",
      `清理 ${deleted} 条孤儿文件元信息`,
    );
  }
  return NextResponse.json({ deleted });
}
