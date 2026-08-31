import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getPanelModelsRoot } from "@/server/locators";
import { listProfiles, scanRepoMarkers } from "@/server/repoProfiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/repos/probe：新建档案时输入 repo 后的探测，body `{ repo }`。
 *
 * 回答两个问题：这个仓库已经有档案了吗（→ 引导去打开）？磁盘上有没有带标记
 * 文件、却没登记的孤儿目录（→ 提示将直接认领）？两者都是设计 D10「删档案
 * 保留文件后，下次填同一仓库会提示」的支撑。
 *
 * 响应 `{ existing: RepoProfile[], orphans: string[] }`：`existing` 是已登记
 * 的同名档案（通常 0 或 1 条，因为同一 repo 可以挂在不同 baseDir 下，故为
 * 数组）；`orphans` 是磁盘上带标记文件、但未被任何档案登记的目录相对路径。
 */
const probeBodySchema = z.strictObject({ repo: z.string().min(1) });

export async function POST(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const parsed = probeBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const db = getDb();
  const { repo } = parsed.data;
  const existing = listProfiles(db).filter((p) => p.repo === repo);
  const registered = new Set(listProfiles(db).map((p) => p.targetDir));
  const orphans = scanRepoMarkers(getPanelModelsRoot())
    .filter((m) => m.repo === repo && !registered.has(m.dir))
    .map((m) => m.dir);

  return NextResponse.json({ existing, orphans });
}
