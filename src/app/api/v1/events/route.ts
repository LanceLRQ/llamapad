import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 默认返回条数与上限（概览事件流卡同为 20 条） */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * GET /api/v1/events?limit=20&kind=model.start：最近事件（ts 倒序）。
 *
 * - limit：缺省 20；上限 100；非法值（非正整数）静默回退默认值
 * - kind：可选过滤（精确匹配，如 model.start / model.stop / model.update /
 *   model.delete / model.start_failed）
 * - 排序 ts DESC, id DESC：ts 为毫秒时间戳，同毫秒内以自增 id 决定先后
 *
 * 响应：`{ events: [{ id, ts, kind, message }] }`
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const params = new URL(req.url).searchParams;

  const rawLimit = params.get("limit");
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (Number.isInteger(parsed) && parsed >= 1) limit = Math.min(parsed, MAX_LIMIT);
  }

  const kind = params.get("kind");
  const db = getDb();
  const rows = (
    kind
      ? db.prepare(
          "SELECT id, ts, kind, message FROM events WHERE kind = ? ORDER BY ts DESC, id DESC LIMIT ?",
        )
      : db.prepare("SELECT id, ts, kind, message FROM events ORDER BY ts DESC, id DESC LIMIT ?")
  ).all(...(kind ? [kind, limit] : [limit])) as {
    id: number;
    ts: number;
    kind: string;
    message: string;
  }[];

  return NextResponse.json({ events: rows });
}
