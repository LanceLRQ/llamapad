import { NextResponse } from "next/server";
import { z } from "zod";
import { ggufPathSchema } from "@/core/schemas";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { computeAndStoreFullHash } from "@/server/fileMeta";
import { getPanelModelsRoot } from "@/server/locators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/file-meta/checksum：手动补算完整哈希（设计 §3.3 的手动兜底按钮）。
 *
 * 大文件的完整哈希是秒级到分钟级的流式读盘，不适合占住 HTTP 请求——路由只做
 * 「条目存在」这一步快速校验（同步查库，不碰磁盘），随后不 await 真正的计算，
 * 立即 202 返回；结果落库后写一条事件，前端靠事件流 / 下次刷新拿到最终值。
 */
const bodySchema = z.strictObject({ path: ggufPathSchema });

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
  const { path } = parsed.data;
  const db = getDb();

  const exists = db.prepare("SELECT 1 FROM file_meta WHERE path = ?").get(path);
  if (!exists) {
    return NextResponse.json({ error: `文件元信息不存在: ${path}` }, { status: 404 });
  }

  const modelsRoot = getPanelModelsRoot();
  void computeAndStoreFullHash(db, modelsRoot, path)
    .then((hash) => {
      db.prepare("INSERT INTO events(ts, kind, message) VALUES (?, ?, ?)").run(
        Date.now(),
        "file_meta.checksum",
        `完整哈希计算完成：${path}（${hash}）`,
      );
    })
    .catch((error: unknown) => {
      db.prepare("INSERT INTO events(ts, kind, message) VALUES (?, ?, ?)").run(
        Date.now(),
        "file_meta.checksum",
        `完整哈希计算失败：${path}（${(error as Error).message}）`,
      );
    });

  return NextResponse.json({ ok: true, status: "started" }, { status: 202 });
}
