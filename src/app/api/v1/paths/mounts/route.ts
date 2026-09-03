import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getDiscoveredMounts } from "@/server/mounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/paths/mounts：当前可用的导入源路径（宿主机视角 + 面板视角成对给出）。
 * 用途有二：填自定义目录时给候选提示；填了个没挂载的路径时，前端据此说清
 * 「该路径在面板容器内不可见，需在 docker-compose.yml 增加挂载」而不是
 * 误导性的「目录不存在」。
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;
  return NextResponse.json({ mounts: getDiscoveredMounts() });
}
