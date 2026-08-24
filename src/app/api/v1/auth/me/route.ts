import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/auth/me：鉴权通过返回当前用户（单管理员面板恒为 admin） */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;
  return NextResponse.json({ ok: true, user: "admin" });
}
