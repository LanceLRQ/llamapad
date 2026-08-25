import { NextResponse } from "next/server";
import { changeAdminPassword, requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PUT /api/v1/auth/password  body { oldPassword, newPassword }：修改管理员密码（M5）。
 * 仅 session；旧密码不符 403（不是 401——请求是已认证的，只是校验没过）。
 * 注意：PANEL_ADMIN_PASSWORD 只在 admins 表为空时引导，改密后该环境变量不再生效。
 */
export async function PUT(req: Request): Promise<Response> {
  const db = getDb();
  const auth = await requireAuth(req, db, { allowBearer: false });
  if (auth instanceof Response) return auth;

  const body = (await req.json().catch(() => null)) as
    | { oldPassword?: unknown; newPassword?: unknown }
    | null;
  const oldPassword = body?.oldPassword;
  const newPassword = body?.newPassword;
  if (typeof oldPassword !== "string" || typeof newPassword !== "string" || newPassword.length < 8) {
    return NextResponse.json({ error: "旧密码必填，新密码至少 8 位" }, { status: 400 });
  }
  if (!(await changeAdminPassword(db, oldPassword, newPassword))) {
    return NextResponse.json({ error: "旧密码不正确" }, { status: 403 });
  }
  return NextResponse.json({ ok: true });
}
