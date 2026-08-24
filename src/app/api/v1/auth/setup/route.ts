import { NextResponse } from "next/server";
import { createAdminIfEmpty } from "@/server/auth";
import { getDb } from "@/server/db";

// 首次引导路由：依赖 better-sqlite3 原生模块，显式 Node.js runtime；
// force-dynamic 防止 build 期静态评估触碰真实库文件。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/v1/auth/setup  body { password }：admins 为空时创建管理员，非空 403 */
export async function POST(req: Request): Promise<Response> {
  const db = getDb();

  const body = (await req.json().catch(() => null)) as { password?: unknown } | null;
  const password = body?.password;
  if (typeof password !== "string" || password.length === 0) {
    return NextResponse.json({ error: "password 必须是非空字符串" }, { status: 400 });
  }

  const { c } = db.prepare("SELECT COUNT(*) AS c FROM admins").get() as { c: number };
  if (c > 0) {
    return NextResponse.json({ error: "管理员已存在，禁止重复初始化" }, { status: 403 });
  }

  try {
    await createAdminIfEmpty(db, password);
  } catch {
    // 并发下的双写兜底（createAdminIfEmpty 内部检查后仍可能撞上竞态）
    return NextResponse.json({ error: "管理员已存在，禁止重复初始化" }, { status: 403 });
  }
  return NextResponse.json({ ok: true });
}
